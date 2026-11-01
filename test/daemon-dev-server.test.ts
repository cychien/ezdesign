import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
const strays = new Set<ChildProcess>()
after(async () => {
  for (const child of strays) if (child.pid) process.kill(-child.pid, 'SIGKILL')
  await world.dispose()
})

interface DevServerState {
  phase: string
  command?: { line: string; cwd: string; source: string }
  origin?: string
  origins?: string[]
  cause?: string
  exitCode?: number
  tail?: string[]
  missing?: { tool: string; install: ({ text: string } | { command: string })[] }[]
}

interface Snapshot {
  app?: string
  appTab: boolean
  devServer: DevServerState
}

const SERVER = `
import { createServer } from 'node:http'
const server = createServer((_req, res) => res.end(process.env.REPLY ?? 'hello from the dev server'))
server.listen(0, '127.0.0.1', () => {
  if (process.env.QUIET !== '1') console.log('\\n  \\x1b[32m➜\\x1b[39m  Local:   http://localhost:\\x1b[1m' + server.address().port + '\\x1b[22m/')
})
`

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ezdesign-devserver-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

/** A task runner, as turbo is: its server in a group of its own, stopped only
 *  when the runner is asked to stop. */
const RUNNER = `
import { spawn } from 'node:child_process'
const server = spawn(process.execPath, ['server.mjs'], { detached: true, stdio: 'inherit' })
process.on('SIGTERM', () => {
  process.kill(-server.pid, 'SIGTERM')
  process.exit(0)
})
`

const npmProject = (dev: string) =>
  project({
    'package.json': JSON.stringify({ name: 'app', scripts: { dev } }),
    'package-lock.json': '{}',
    'server.mjs': SERVER,
    'runner.mjs': RUNNER,
  })

async function api(port: number, path: string, body: unknown = {}, method = 'POST'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/__ezdesign/api/dev-server/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
}

async function phase(port: number, wanted: string): Promise<Snapshot> {
  return waitFor(async () => {
    const s = (await world.state(port)) as unknown as Snapshot
    return s.devServer.phase === wanted ? s : null
  }, `the dev server to be ${wanted}`)
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

world.spawnDaemon()
const daemon = await world.liveDaemon()

test('the empty App tab starts the detected command, and the page is served through the session', async () => {
  const dir = npmProject('node server.mjs')
  const { port } = await world.openSession(daemon.port, { project: dir })
  const before = (await world.state(port)) as unknown as Snapshot
  assert.equal(before.appTab, true, 'a project with a package.json gets an App tab')
  assert.deepEqual(before.devServer, { phase: 'idle', command: { line: 'npm run dev', cwd: '', source: 'detected' } })

  assert.equal((await api(port, 'start', { host: 'browser' })).status, 202)
  const running = await phase(port, 'running')
  assert.match(running.devServer.origin!, /^http:\/\/localhost:\d+$/)
  assert.equal(running.app, running.devServer.origin, 'the App tab shows what it printed')
  const page = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(await page.text(), 'hello from the dev server')

  const log = (await (await api(port, 'log', undefined, 'GET')).json()) as { lines: string[] }
  assert.equal(log.lines[0], '$ npm run dev')
  assert.ok(log.lines.some((l) => l.includes(`Local:   ${running.devServer.origin}/`)), 'the log is ANSI-free')

  assert.equal((await api(port, 'stop')).status, 200)
  const stopped = (await world.state(port)) as unknown as Snapshot
  assert.equal(stopped.devServer.phase, 'stopped')
  assert.equal(stopped.app, undefined, 'a stopped server leaves the App tab')
  assert.equal(stopped.appTab, true)
  await assert.rejects(fetch(running.devServer.origin!, { signal: AbortSignal.timeout(1000) }), 'the group is gone')
})

test('a crash shows its last lines; a restart after the fix brings the page back', async () => {
  const dir = npmProject('node crash.mjs')
  writeFileSync(join(dir, 'crash.mjs'), "console.error('Error: Cannot find module ./missing.js'); process.exit(1)\n")
  const { port } = await world.openSession(daemon.port, { project: dir })
  await api(port, 'start', { host: 'browser' })
  const crashed = await phase(port, 'crashed')
  assert.equal(crashed.devServer.cause, 'exited')
  assert.equal(crashed.devServer.exitCode, 1)
  assert.ok(crashed.devServer.tail!.includes('Error: Cannot find module ./missing.js'))

  writeFileSync(join(dir, 'crash.mjs'), SERVER)
  await api(port, 'restart', { host: 'browser' })
  const back = await phase(port, 'running')
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'hello from the dev server')
  assert.equal(back.devServer.command?.line, 'npm run dev')
  await api(port, 'stop')
})

test('a tool the PATH does not have is named with how to install it, and nothing runs', async () => {
  const dir = project({ 'index.html': '<p>static</p>' })
  const { port } = await world.openSession(daemon.port, { project: dir })
  const before = (await world.state(port)) as unknown as Snapshot
  assert.equal(before.appTab, false, 'no package.json and no command: canvases only, as before')

  const res = await api(port, 'command', { line: 'ezdesign-no-such-tool serve', cwd: '', host: 'browser' })
  assert.equal(res.status, 202)
  const blocked = await phase(port, 'blocked')
  assert.deepEqual(blocked.devServer.missing, [
    {
      tool: 'ezdesign-no-such-tool',
      install: [{ text: '安裝 ' }, { command: 'ezdesign-no-such-tool' }, { text: '，並確認登入 shell 的 PATH 找得到它' }],
    },
  ])
  assert.equal(blocked.appTab, true)

  assert.equal((await api(port, 'command', { line: 'node a\nnode b', cwd: '' })).status, 400)
  assert.equal((await api(port, 'command', { line: 'node a', cwd: '../elsewhere' })).status, 400)
})

test('a server that prints no URL is found by the port it opened', async () => {
  const dir = npmProject('QUIET=1 node server.mjs')
  const { port } = await world.openSession(daemon.port, { project: dir })
  await api(port, 'start', { host: 'browser' })
  const running = await phase(port, 'running')
  assert.match(running.devServer.origin!, /^http:\/\/localhost:\d+$/)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'hello from the dev server')
  await api(port, 'stop')
})

test("the user's own server at the recorded origin is used, and never stopped", async () => {
  const dir = npmProject('node server.mjs')
  const own = spawn(process.execPath, ['server.mjs'], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  strays.add(own)
  const origin = await new Promise<string>((resolve) =>
    own.stdout!.on('data', (c: Buffer) => {
      const m = /http:\/\/localhost:\S*?(\d+)/.exec(c.toString().replace(/\x1b\[[0-9;]*m/g, ''))
      if (m) resolve(`http://localhost:${m[1]}`)
    }),
  )
  const { port } = await world.openSession(daemon.port, { project: dir, url: origin })
  await api(port, 'start', { host: 'browser' })
  const external = await phase(port, 'external')
  assert.equal(external.devServer.origin, origin)
  assert.equal((await api(port, 'stop')).status, 409)
  assert.equal(alive(own.pid!), true)
})

test('a web page cannot stop the daemon; the CLI still can', async () => {
  const refused = await fetch(`http://127.0.0.1:${daemon.port}/control/stop`, {
    method: 'POST',
    headers: { origin: 'https://example.com', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(refused.status, 403)
  assert.equal((await world.health(daemon.port))?.ok, true)
})

test('a self-update handover restarts the dev server for the same initiator', async () => {
  const dir = npmProject('node runner.mjs')
  const { port } = await world.openSession(daemon.port, { project: dir })
  await api(port, 'start', { host: 'browser' })
  const first = await phase(port, 'running')

  world.spawnDaemon(['--succeed', String(daemon.pid)])
  await world.stopDaemon(daemon.port)
  await assert.rejects(
    fetch(first.devServer.origin!, { signal: AbortSignal.timeout(1000) }),
    'the old daemon asked the runner to stop, and its server went with it',
  )

  const successor = await world.liveDaemon()
  assert.notEqual(successor.pid, daemon.pid)
  const back = await phase(port, 'running')
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'hello from the dev server')
  assert.equal(back.app, back.devServer.origin)
})
