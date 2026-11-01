import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, PKG_VERSION, sessionKey, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
writeFileSync(join(world.dataDir, 'preferences.json'), JSON.stringify({ lastAgent: FAKE_AGENT }))
world.spawnDaemon()
const daemon = await world.liveDaemon()
const health = (await world.health(daemon.port)) as { desktop?: number }
process.env.EZDESIGN_DATA_DIR = world.dataDir
const { installedVersion, newestInstalled, seedBundledPackage, speaksContract } = await import('../src/desktop-host.js')
const { resolveDaemon } = await import('../src/registry.js')
after(() => world.dispose())

const VERSIONS = join(world.dataDir, 'versions')

function prefix(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ezdesign-prefix-'))
  const pkg = join(root, 'node_modules', '@cychien', 'ezdesign')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@cychien/ezdesign', version }))
  writeFileSync(join(pkg, 'dist', 'cli.mjs'), '')
  return root
}

test('the app adopts any daemon that speaks its contract, whatever its version', () => {
  assert.equal(speaksContract({ desktopContract: 1 }), true)
  assert.equal(speaksContract({ desktopContract: 2 }), true)
  assert.equal(speaksContract({}), false, 'a daemon from before the app is replaced at launch')
})

test('the bundled package is seeded once, and a half-seeded copy is replaced', async () => {
  await seedBundledPackage(prefix('9.9.1'), '9.9.1')
  assert.equal(installedVersion('9.9.1'), true)
  await seedBundledPackage(prefix('9.9.1'), '9.9.1')

  mkdirSync(join(VERSIONS, '9.9.2', 'node_modules'), { recursive: true })
  assert.equal(installedVersion('9.9.2'), false)
  await seedBundledPackage(prefix('9.9.2'), '9.9.2')
  assert.equal(installedVersion('9.9.2'), true)
})

test('the newest installed version runs, never one older than the bundled', async () => {
  await seedBundledPackage(prefix('9.10.0'), '9.10.0')
  mkdirSync(join(VERSIONS, '9.11.0'), { recursive: true })
  assert.equal(newestInstalled('9.9.1'), '9.10.0', 'a broken 9.11.0 is skipped')
  assert.equal(newestInstalled('9.12.0', []), '9.12.0')
})


test('health says which desktop contract the daemon serves', () => {
  assert.equal(health.desktop, 1)
})

test('an older CLI re-runs on the newer daemon’s own CLI rather than downgrading it', async () => {
  const older = '0.0.1'
  assert.deepEqual(await resolveDaemon('/unused/cli.mjs', PKG_VERSION).then((r) => r.kind), 'ours')
  const own = join(VERSIONS, PKG_VERSION, 'node_modules', '@cychien', 'ezdesign', 'dist', 'cli.mjs')
  mkdirSync(join(own, '..'), { recursive: true })
  writeFileSync(own, '')
  const resolved = await resolveDaemon('/unused/cli.mjs', older)
  assert.deepEqual({ kind: resolved.kind, cliEntry: 'cliEntry' in resolved ? resolved.cliEntry : null }, { kind: 'newer', cliEntry: own })
  assert.equal((await world.health(daemon.port))?.pid, daemon.pid, 'the newer daemon keeps running')
  rmSync(join(VERSIONS, PKG_VERSION), { recursive: true })
})

const SERVER = `
import { createServer } from 'node:http'
const server = createServer((_req, res) => res.end('hello'))
server.listen(0, '127.0.0.1', () => console.log('  Local:   http://localhost:' + server.address().port + '/'))
`

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ezdesign-desktop-project-')))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts: { dev: 'node server.mjs' } }))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  writeFileSync(join(dir, 'server.mjs'), SERVER)
  return dir
}

const desktop = (route: string, body: unknown, contract: string | null = '1') =>
  fetch(`http://127.0.0.1:${daemon.port}/control/desktop/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(contract ? { 'x-ezdesign-desktop': contract } : {}) },
    body: JSON.stringify(body),
  })

async function phase(project: string): Promise<string | undefined> {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/__ezdesign/api/projects`, {
    headers: { 'x-ezdesign-version': PKG_VERSION },
  })
  const list = (await res.json()) as { projects: { project: string; session: { devServer: { phase: string } } | null }[] }
  return list.projects.find((p) => p.project === project)?.session?.devServer.phase
}

test('the desktop routes answer only the contract', async () => {
  assert.equal((await desktop('quit', {}, null)).status, 409)
  assert.equal((await desktop('quit', {}, '2')).status, 409)
})

test('app quit stops the dev servers the app started, and only those', async () => {
  const fromApp = project()
  const fromBrowser = project()
  const opened = (await (await desktop('open', { path: fromApp })).json()) as { project: string; shellUrl: string }
  assert.equal(opened.project, fromApp, 'a folder from the Dock is added and opened')
  assert.equal(await phase(fromApp), 'idle', 'opening starts nothing')
  await fetch(`http://127.0.0.1:${daemon.port}/__ezdesign/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ezdesign-version': PKG_VERSION },
    body: JSON.stringify({ path: fromBrowser }),
  })
  const other = await fetch(`http://127.0.0.1:${daemon.port}/__ezdesign/api/projects/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ezdesign-version': PKG_VERSION },
    body: JSON.stringify({ project: fromBrowser, host: 'browser' }),
  })
  const start = (shellUrl: string, host: string) =>
    fetch(new URL('/__ezdesign/api/dev-server/start', shellUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host }),
    })
  await start(opened.shellUrl, 'desktop')
  await start(((await other.json()) as { shellUrl: string }).shellUrl, 'browser')
  await waitFor(async () => (await phase(fromApp)) === 'running' && (await phase(fromBrowser)) === 'running', 'both servers to run')

  assert.deepEqual(await (await desktop('quit', {})).json(), { stopped: 1 })
  assert.equal(await phase(fromApp), 'stopped')
  assert.equal(await phase(fromBrowser), 'running', "a browser shell's server survives the app")
})

test('app quit leaves an agent the CLI connected', async () => {
  const dir = project()
  const opened = await world.openSession(daemon.port, { project: dir, agent: FAKE_AGENT })
  await waitFor(async () => ((await world.state(opened.port)) as { acp?: { state: string } }).acp?.state === 'idle', 'the agent to connect')
  assert.equal((await desktop('quit', {})).status, 200)
  const state = (await world.state(opened.port)) as { acp?: { agent: string } }
  assert.equal(state.acp?.agent, FAKE_AGENT)
})

// Last: it replaces the daemon.
test('app quit disconnects the agent its window connected, even after a daemon restart', async () => {
  const dir = project()
  const opened = await world.openSession(daemon.port, { project: dir, agent: FAKE_AGENT })
  const idle = async (port: number) =>
    waitFor(async () => ((await world.state(port)) as { acp?: { state: string } }).acp?.state === 'idle', 'the agent to connect')
  await idle(opened.port)
  const file = join(world.dataDir, 'sessions', sessionKey(dir), 'session.json')
  await world.stopDaemon(daemon.port)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), agentBy: 'desktop' }))

  world.spawnDaemon()
  const next = await world.liveDaemon()
  const found = await world.control(next.port, `/control/sessions/find?project=${encodeURIComponent(dir)}`)
  const { port } = (await found.json()) as { port: number }
  await idle(port)
  const quit = await fetch(`http://127.0.0.1:${next.port}/control/desktop/quit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ezdesign-desktop': '1' },
    body: '{}',
  })
  assert.equal(quit.status, 200)
  assert.equal(((await world.state(port)) as { acp?: unknown }).acp, undefined)
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { agent?: string }).agent, undefined, 'and stays disconnected')
})
