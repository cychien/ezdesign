import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const DEV_DATA_DIR = join(REPO_ROOT, '.dev')
export const FIXTURE_ROOT = join(REPO_ROOT, 'fixtures/playground')
export const CLI = join(REPO_ROOT, 'dist/cli.mjs')
/** What `npm run dev` is currently serving and where its daemon listens, so
 *  companion scripts reach this checkout's stack instead of guessing. */
export const STATE_FILE = join(DEV_DATA_DIR, 'dev.json')
const REGISTRY_FILE = join(DEV_DATA_DIR, 'daemon.json')

/** A dev daemon must differ from the real one, and from every other checkout's,
 *  in *both* data dir and control range: `daemonMain` adopts any live daemon it
 *  finds in its range. Each checkout gets its own ten-port block in 4100-4199,
 *  clear of the real daemon (4400-4409), the test suite's (4440-4649), the
 *  verify driver's (4600-5299) and the dev servers vite counts up from 5173. */
const CONTROL_BLOCKS = Array.from({ length: 10 }, (_, i) => 4100 + i * 10)
const FIXTURE_PORTS = Array.from({ length: 100 }, (_, i) => 5173 + i)
const REPO_HASH = parseInt(createHash('sha1').update(REPO_ROOT).digest('hex').slice(0, 8), 16)

/** The ACP agent `npm run dev` brings up. Poll mode is deprecated; dev mode has
 *  no reason to exercise it. */
export const DEV_AGENT = 'claude'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The one this checkout last ran on, else the one its path hashes to. */
function preferred(candidates, recorded) {
  return candidates.includes(recorded) ? recorded : candidates[REPO_HASH % candidates.length]
}

export function devControlPort() {
  return preferred(CONTROL_BLOCKS, readJson(STATE_FILE)?.controlPort)
}

export function devEnv() {
  return {
    ...process.env,
    EZDESIGN_DATA_DIR: DEV_DATA_DIR,
    EZDESIGN_CONTROL_PORT: String(devControlPort()),
  }
}

function connects(host, port) {
  return new Promise((done) => {
    const socket = connect({ host, port })
    const finish = (ok) => {
      socket.destroy()
      done(ok)
    }
    socket.setTimeout(400, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function portBusy(port) {
  const answers = await Promise.all(['127.0.0.1', '::1'].map((host) => connects(host, port)))
  return answers.some(Boolean)
}

/** The first of `candidates`, from `from` on, whose `width` ports are all free.
 *  Starting where this checkout last ran keeps its origin stable. */
async function firstFree(candidates, from, width) {
  const start = candidates.indexOf(from)
  for (let i = 0; i < candidates.length; i++) {
    const base = candidates[(start + i) % candidates.length]
    const ports = Array.from({ length: width }, (_, j) => base + j)
    if (!(await Promise.all(ports.map(portBusy))).some(Boolean)) return base
  }
  throw new Error(`no free ports in ${candidates[0]}-${candidates.at(-1) + width - 1}`)
}

/** Ports for a fresh `npm run dev`. Only call it once this checkout's own daemon
 *  is cleared, or its block counts as taken. */
export async function claimDevPorts() {
  return {
    controlPort: await firstFree(CONTROL_BLOCKS, devControlPort(), 10),
    fixturePort: await firstFree(
      FIXTURE_PORTS,
      preferred(FIXTURE_PORTS, readJson(STATE_FILE)?.fixturePort),
      1,
    ),
  }
}

/** The live daemon this checkout's registry names, whoever started it. */
export async function registeredDaemon() {
  const reg = readJson(REGISTRY_FILE)
  if (!reg) return null
  try {
    const res = await fetch(`http://127.0.0.1:${reg.port}/control/health`, {
      signal: AbortSignal.timeout(800),
    })
    const body = res.ok ? await res.json() : null
    return body?.ok && body.pid === reg.pid ? { port: reg.port, pid: reg.pid } : null
  } catch {
    return null
  }
}

export function commandOf(pid) {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

/** The registry alone is no proof: a daemon that finds a live one in its range
 *  records that one, and it can be another checkout's. Ours runs our CLI. */
export async function ownDaemon() {
  const daemon = await registeredDaemon()
  return daemon && commandOf(daemon.pid).includes(` ${CLI} __daemon`) ? daemon : null
}

export function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: devEnv(),
      // A session is scoped to the project the CLI was run from, so callers that
      // care about the scope pass it.
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    })
    let out = ''
    child.stdout?.on('data', (c) => {
      out += c
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ezdesign ${args[0]} exited with ${code}`)),
    )
  })
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms))

export function devTargetUrl() {
  const url = readJson(STATE_FILE)?.url
  if (!url) throw new Error('no dev session on record - run `npm run dev` first')
  return url
}
