import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DEV_SERVER_LOG_LINES } from '../constants.js'
import { killGroup, trackGroup, untrackGroup } from '../child-groups.js'
import { OriginScanner, parseListeningPorts } from './urls.js'
import type { DevServerLogWire } from './wire.js'

export interface LaunchSpec {
  line: string
  absoluteCwd: string
}

export interface ProcessListener {
  /** Complete lines, ANSI stripped, and every local origin printed so far. */
  output(lines: readonly string[], origins: readonly string[]): void
  exited(code: number | null, signal: string | null): void
  spawnFailed(error: string): void
}

/** `BROWSER=none` keeps Vite's `--open` and create-react-app from opening a
 *  browser tab beside the App tab. */
export const DEV_SERVER_ENV: Readonly<Record<string, string>> = { BROWSER: 'none' }

export class ManagedProcess {
  private readonly scanner = new OriginScanner()
  private exitedAt: number | null = null
  /** Settles once the leader has exited and its pipes are drained. */
  readonly closed: Promise<void>
  private markClosed!: () => void

  private constructor(readonly pid: number | undefined) {
    this.closed = new Promise((resolve) => (this.markClosed = resolve))
  }

  /** Never throws: a shell that cannot start reports through `spawnFailed`. */
  static launch(spec: LaunchSpec, log: LogRing, listener: ProcessListener): ManagedProcess {
    let child: ChildProcess
    try {
      child = spawn(spec.line, {
        shell: true,
        detached: true,
        cwd: spec.absoluteCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...DEV_SERVER_ENV },
      })
    } catch (error) {
      const proc = new ManagedProcess(undefined)
      proc.markClosed()
      queueMicrotask(() => listener.spawnFailed(error instanceof Error ? error.message : String(error)))
      return proc
    }
    const proc = new ManagedProcess(child.pid)
    const pid = child.pid
    if (pid) trackGroup(pid, spec.line)
    const take = (chunk: Buffer) => {
      const lines = proc.scanner.push(chunk.toString())
      if (!lines.length) return
      log.push(lines)
      listener.output(lines, proc.scanner.origins)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    // The leader gone is the server gone: whatever it left in the group would
    // hold the pipes open, and with them the close below.
    child.on('exit', () => {
      if (!pid) return
      try {
        // The group only: the leader's pid is free to be reused now.
        process.kill(-pid, 'SIGTERM')
      } catch {}
    })
    child.on('error', (error) => {
      if (pid) untrackGroup(pid)
      if (proc.exitedAt !== null) return
      proc.exitedAt = Date.now()
      proc.markClosed()
      listener.spawnFailed(error.message)
    })
    // Not 'exit': the pipes may still hold the last lines.
    child.on('close', (code, signal) => {
      if (pid) untrackGroup(pid)
      if (proc.exitedAt !== null) return
      const rest = proc.scanner.flush()
      if (rest.length) {
        log.push(rest)
        listener.output(rest, proc.scanner.origins)
      }
      proc.exitedAt = Date.now()
      proc.markClosed()
      listener.exited(code, signal)
    })
    return proc
  }

  get running(): boolean {
    return this.pid !== undefined && this.exitedAt === null
  }

  async stop(graceMs: number): Promise<void> {
    const pid = this.pid
    if (!this.running || pid === undefined) return
    killGroup(pid, graceMs > 0 ? 'SIGTERM' : 'SIGKILL')
    const hard = setTimeout(() => killGroup(pid, 'SIGKILL'), graceMs)
    hard.unref()
    await this.closed
    clearTimeout(hard)
  }

  async listeningOrigins(): Promise<string[]> {
    if (!this.running || this.pid === undefined) return []
    const pids = (await run('pgrep', ['-g', String(this.pid)])).split(/\s+/).filter(Boolean)
    if (!pids.length) return []
    const listening = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(','), '-F', 'pn'])
    return parseListeningPorts(listening).map((port) => `http://localhost:${port}`)
  }
}

const execFileAsync = promisify(execFile)

/** stdout, or empty when the tool fails - `lsof` and `pgrep` exit 1 on no match. */
async function run(file: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync(file, args, { encoding: 'utf8', timeout: 5_000 })).stdout
  } catch {
    return ''
  }
}

export class LogRing {
  private lines: string[] = []
  private dropped = 0

  constructor(private readonly cap: number = DEV_SERVER_LOG_LINES) {}

  push(lines: readonly string[]): void {
    this.lines.push(...lines)
    const over = this.lines.length - this.cap
    if (over > 0) {
      this.lines.splice(0, over)
      this.dropped += over
    }
  }

  tail(count: number): string[] {
    return this.lines.slice(-count)
  }

  clear(): void {
    this.lines = []
    this.dropped = 0
  }

  wire(): DevServerLogWire {
    return { lines: [...this.lines], dropped: this.dropped }
  }
}

export async function originAnswers(origin: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    await res.body?.cancel()
    return true
  } catch {
    return false
  }
}

export type ListenerCwd = { kind: 'known'; path: string } | { kind: 'unknown' }

export async function listenerCwd(origin: string): Promise<ListenerCwd> {
  let port: string
  try {
    const url = new URL(origin)
    port = url.port || (url.protocol === 'https:' ? '443' : '80')
  } catch {
    return { kind: 'unknown' }
  }
  const pid = (await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).split(/\s+/).find(Boolean)
  if (!pid) return { kind: 'unknown' }
  const cwd = (await run('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])).split('\n').find((l) => l.startsWith('n'))
  return cwd ? { kind: 'known', path: cwd.slice(1) } : { kind: 'unknown' }
}
