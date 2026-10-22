import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'
import { targets, watchAll } from './build.mjs'
import {
  CLI,
  DEV_AGENT,
  DEV_DATA_DIR,
  FIXTURE_ROOT,
  STATE_FILE,
  claimDevPorts,
  commandOf,
  delay,
  devControlPort,
  devEnv,
  ownDaemon,
  registeredDaemon,
  runCli,
} from './dev-env.mjs'

const noPlugin = process.argv.includes('--no-plugin')
const log = (msg) => console.log(`\x1b[36m[dev]\x1b[0m ${msg}`)
const warn = (msg) => console.log(`\x1b[33m[dev]\x1b[0m ${msg}`)

// The verify stack seeds the same folder and deletes it on `vz.mjs down`.
if (existsSync(join(FIXTURE_ROOT, '.ezdesign', '.vz-seeded'))) {
  warn('a verify stack (vz.mjs) owns fixtures/playground/.ezdesign - run `vz.mjs down` first')
  process.exit(1)
}

let shuttingDown = false
let daemon = null
let disposeWatch = null
let vite = null

/** A daemon that keeps crashing is almost always the edit under test, and a 4Hz
 *  respawn loop buries the stack trace that says so. Give up after this many
 *  crashes inside the window and wait for the next save to try again. */
const CRASH_GIVE_UP_COUNT = 3
const CRASH_WINDOW_MS = 5000
let crashTimes = []

function startDaemon() {
  daemon = spawn(process.execPath, [CLI, '__daemon'], {
    env: devEnv(),
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const child = daemon
  child.on('exit', async (code) => {
    if (shuttingDown || child !== daemon) return
    // A daemon that finds a live one in its control range registers that one and
    // exits 0 instead of serving. Restarting into that is an infinite loop.
    const squatter = await registeredDaemon()
    if (squatter) {
      warn(`daemon exited (${code}) - its control range is held by pid ${squatter.pid}`)
      warn('re-run `npm run dev` to move to a free one')
      await shutdown()
      return
    }
    const now = Date.now()
    crashTimes = [...crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    if (crashTimes.length >= CRASH_GIVE_UP_COUNT) {
      daemon = null
      crashTimes = []
      warn(`daemon exited (${code}) ${CRASH_GIVE_UP_COUNT} times in a row - it does not boot`)
      warn('fix the error above; the next successful build restarts it')
      return
    }
    warn(`daemon exited (${code}); restarting`)
    await delay(250)
    if (!shuttingDown && child === daemon) startDaemon()
  })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** `npm run dev` must be idempotent after a hard kill, so this checkout's
 *  orphaned daemon is cleared. Only ever this checkout's: other checkouts run
 *  their own, and a daemon this one cannot prove is its own is left alone. */
async function clearStrayDaemon() {
  const registered = await registeredDaemon()
  if (!registered) return
  const stray = await ownDaemon()
  if (!stray) {
    warn(
      `leaving pid ${registered.pid} alone - not this checkout's daemon: ${commandOf(registered.pid)}`,
    )
    return
  }
  warn(`clearing an orphaned dev daemon on ${stray.port} (pid ${stray.pid})`)
  await fetch(`http://127.0.0.1:${stray.port}/control/stop`, { method: 'POST' }).catch(() => {})
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!alive(stray.pid)) return
    await delay(150)
  }
  throw new Error(`could not clear the daemon on ${stray.port} (pid ${stray.pid})`)
}

/** Resolves true once the daemon we just spawned is the one answering - matching
 *  on pid, because a restart usually reclaims the same port and a stale registry
 *  from the previous one would otherwise look healthy. False once the start has
 *  been abandoned, so the crash cap does not leave a caller waiting out the whole
 *  timeout for a pid that will never answer. */
async function waitForDaemon(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!daemon) return false
    if ((await registeredDaemon())?.pid === daemon?.pid) return true
    await delay(150)
  }
  throw new Error(
    `dev daemon did not come up on 127.0.0.1:${devControlPort()}-${devControlPort() + 9}`,
  )
}

/** Resolves once the child is really gone. SIGTERM alone is not enough: a daemon
 *  wedged by the edit under test never runs its handler, and the orphan it leaves
 *  on the control port cannot be cleared on the next run either. */
async function killDaemon(child, graceMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const dead = once(child, 'exit')
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), graceMs)
  try {
    await dead
  } finally {
    clearTimeout(force)
  }
}

/** Never overlaps two daemons: the replacement would find the dying one still
 *  listening in its range and adopt it instead of taking over. */
async function restartDaemon() {
  const dying = daemon
  daemon = null
  await killDaemon(dying)
  startDaemon()
  if (await waitForDaemon()) log('daemon restarted - in-flight polls reconnect on their own')
}

let restartChain = Promise.resolve()
let restartPending = false

/** Coalesces the burst of rebuilds one save produces, then serialises what is
 *  left. A plain pre-restart flag only debounces the window before a restart, so
 *  two saves a blink apart would run `restartDaemon` concurrently. */
function onNodeRebuild() {
  if (restartPending) return restartChain
  restartPending = true
  restartChain = restartChain.then(async () => {
    await delay(50)
    restartPending = false
    if (shuttingDown) return
    await restartDaemon().catch((err) => warn(`restart failed: ${err.message}`))
  })
  return restartChain
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('')
  log('shutting down')
  await Promise.allSettled([killDaemon(daemon), disposeWatch?.(), vite?.close()])
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const builtOnce = new Set()
let firstBuildDone
const firstBuild = new Promise((resolve) => {
  firstBuildDone = resolve
})

disposeWatch = await watchAll((group, outfile, result) => {
  if (result.errors.length) {
    warn(`build failed: ${outfile}`)
    return
  }
  if (!builtOnce.has(outfile)) {
    builtOnce.add(outfile)
    if (builtOnce.size === targets.length) firstBuildDone()
    return
  }
  if (group === 'node') {
    log(`${outfile} changed - restarting daemon`)
    void onNodeRebuild()
  } else {
    log(`${outfile} changed - reload the browser`)
  }
})
await firstBuild
log('watching src/')

await clearStrayDaemon()
const { controlPort, fixturePort } = await claimDevPorts()

vite = await createServer({
  root: FIXTURE_ROOT,
  configFile: join(FIXTURE_ROOT, noPlugin ? 'vite.noplugin.config.ts' : 'vite.config.ts'),
  server: { port: fixturePort, strictPort: true },
})
await vite.listen()
const targetUrl = vite.resolvedUrls?.local?.[0]
if (!targetUrl) throw new Error('vite did not report a local url')
log(`fixture on ${targetUrl}${noPlugin ? ' (no ezdesignSource - anchors have no source)' : ''}`)

mkdirSync(DEV_DATA_DIR, { recursive: true })
writeFileSync(STATE_FILE, JSON.stringify({ url: targetUrl, controlPort, fixturePort }, null, 2))

startDaemon()
if (!(await waitForDaemon())) throw new Error('dev daemon gave up during startup')
// ACP, always. Poll mode is deprecated, and a first run with no session to
// restore would otherwise come up without an agent. Run from the fixture so the
// review is scoped to it rather than to this repository: the agent's cwd is the
// project under review, and that is what it edits.
await runCli([targetUrl, '--agent', DEV_AGENT], { cwd: FIXTURE_ROOT })

log('review shell open')
