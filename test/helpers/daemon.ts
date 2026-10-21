import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const CLI_SRC = join(ROOT, 'src', 'cli.ts')
export const FAKE_AGENT = `node ${join(ROOT, 'test', 'helpers', 'fake-acp-agent.mjs')}`
export const PKG_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await probe()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(100)
  }
}

function bind(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(null))
    server.listen(port, '127.0.0.1', () => resolve(server.unref()))
  })
}

/** Ten free ports, held until a daemon needs them so that no other world - in
 *  this run or a concurrent one - can pick them meanwhile. Drawn from well away
 *  from the user's daemon, the dev and verify harnesses (all below 5000) and the
 *  ephemeral ports sessions bind. */
async function reserveControlBlock(): Promise<{ start: number; held: Server[] }> {
  for (;;) {
    const start = 20_000 + 10 * Math.floor(Math.random() * 1200)
    const held: Server[] = []
    for (let port = start; port < start + 10; port++) {
      const server = await bind(port)
      if (!server) break
      held.push(server)
    }
    if (held.length === 10) return { start, held }
    for (const server of held) server.close()
  }
}

/** One isolated daemon world: its own data dir, control range and home, so a
 *  test never meets the developer's real daemon, registry lookups, or skill
 *  installs. */
export class DaemonWorld {
  readonly dataDir = mkdtempSync(join(tmpdir(), 'ezdesign-daemon-'))
  readonly env: NodeJS.ProcessEnv
  readonly children = new Set<ChildProcess>()
  private held: Server[] = []

  /** A world on a control range of its own. */
  static async create(): Promise<DaemonWorld> {
    const { start, held } = await reserveControlBlock()
    const world = new DaemonWorld(start)
    world.held = held
    return world
  }

  /** A world on `controlPort`'s range, for a test that shares one on purpose. */
  constructor(readonly controlPort: number) {
    this.env = {
      ...process.env,
      EZDESIGN_DATA_DIR: this.dataDir,
      EZDESIGN_CONTROL_PORT: String(controlPort),
      EZDESIGN_NO_UPDATE_CHECK: '1',
      EZDESIGN_DESIGN_HARNESS: '1',
      HOME: this.dataDir,
      USERPROFILE: this.dataDir,
    }
  }

  /** Runs the daemon from source, the way the CLI would from `dist`. */
  spawnDaemon(extraArgs: string[] = []): ChildProcess {
    this.release()
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_SRC, '__daemon', ...extraArgs], {
      env: this.env,
      stdio: 'ignore',
    })
    this.children.add(child)
    child.on('exit', () => this.children.delete(child))
    return child
  }

  registry(): { port: number; pid: number } | null {
    try {
      return JSON.parse(readFileSync(join(this.dataDir, 'daemon.json'), 'utf8'))
    } catch {
      return null
    }
  }

  async health(port: number): Promise<{ ok: boolean; version?: string; pid?: number } | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/control/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (!res.ok) return null
      return (await res.json()) as { ok: boolean; version?: string; pid?: number }
    } catch {
      return null
    }
  }

  /** The daemon that currently owns the registry and answers healthy, once it
   *  has restored its sessions: it answers health before their ports are bound. */
  async liveDaemon(): Promise<{ port: number; pid: number }> {
    const live = await waitFor(async () => {
      const info = this.registry()
      if (!info) return null
      const h = await this.health(info.port)
      return h?.ok && h.pid === info.pid ? info : null
    }, 'a live daemon')
    const sessions = await this.control(live.port, '/control/sessions')
    if (!sessions.ok) throw new Error(`daemon on ${live.port} answered ${sessions.status}`)
    return live
  }

  /** Runs the CLI from source with this world's environment. */
  async cli(...args: string[]): Promise<string> {
    const run = promisify(execFile)
    const { stdout } = await run(process.execPath, ['--import', 'tsx', CLI_SRC, ...args], {
      env: this.env,
    })
    return stdout
  }

  async control(port: number, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-ezdesign-version': PKG_VERSION,
        ...(init?.headers ?? {}),
      },
    })
  }

  async openSession(
    controlPort: number,
    body: { url: string; project: string; agent?: string; reopen?: boolean },
  ): Promise<{ port: number; shellUrl: string; agent?: string }> {
    const res = await this.control(controlPort, '/control/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`open session failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as { port: number; shellUrl: string; agent?: string }
  }

  async state(sessionPort: number): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${sessionPort}/__ezdesign/api/state`)
    return (await res.json()) as Record<string, unknown>
  }

  /** Queue one annotation and send it. Returns once the daemon holds the batch,
   *  whether or not any agent is there to take it. */
  async postFeedback(sessionPort: number, comment: string): Promise<void> {
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${sessionPort}/__ezdesign/api/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`)
    }
    await post('annotations', { kind: 'element', comment, anchor: { selector: 'div' } })
    await post('send', { note: null })
  }

  /** Post feedback and wait for the agent's reply: a session is only resumable
   *  once a turn on it has ended. */
  async sendFeedback(sessionPort: number, comment: string): Promise<void> {
    const replies = async () => {
      const { conversation } = (await this.state(sessionPort)) as {
        conversation: { role: string }[]
      }
      return conversation.filter((e) => e.role === 'agent').length
    }
    const before = await replies()
    await this.postFeedback(sessionPort, comment)
    await waitFor(async () => (await replies()) > before, 'the agent to answer the feedback')
  }

  /** Stops the daemon on `port` and waits for its process to be gone, ports
   *  and all - a stopping daemon answers 503 before it has exited. */
  async stopDaemon(port: number): Promise<void> {
    const pid = (await this.health(port))?.pid
    await fetch(`http://127.0.0.1:${port}/control/stop`, { method: 'POST' }).catch(() => {})
    await waitFor(async () => {
      if (pid === undefined) return !(await this.health(port))
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 'daemon to exit')
  }

  private release(): void {
    for (const server of this.held.splice(0)) server.close()
  }

  async dispose(): Promise<void> {
    this.release()
    const info = this.registry()
    if (info) await this.stopDaemon(info.port).catch(() => {})
    for (const child of this.children) child.kill('SIGKILL')
  }
}
