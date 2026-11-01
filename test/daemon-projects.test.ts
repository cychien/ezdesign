import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, PKG_VERSION, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
after(() => world.dispose())

world.spawnDaemon()
const daemon = await world.liveDaemon()
const CONTROL = `http://127.0.0.1:${daemon.port}`
const API = `${CONTROL}/__ezdesign/api/projects`
const VERSIONED = { 'content-type': 'application/json', 'x-ezdesign-version': PKG_VERSION }

interface ProjectRow {
  project: string
  name: string
  usedAt: number | null
  exists: boolean
  session: { devServer: { phase: string; origin?: string } } | null
}
interface ProjectList {
  version: string
  projects: ProjectRow[]
}

const SERVER = `
import { createServer } from 'node:http'
const server = createServer((_req, res) => res.end('hello'))
server.listen(0, '127.0.0.1', () => console.log('  Local:   http://localhost:' + server.address().port + '/'))
`

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ezdesign-project-')))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts: { dev: 'node server.mjs' } }))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  writeFileSync(join(dir, 'server.mjs'), SERVER)
  return dir
}

const post = (url: string, body: unknown, headers: Record<string, string> = VERSIONED) =>
  fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
const list = async (url = API): Promise<ProjectList> => (await fetch(url, { headers: VERSIONED })).json() as Promise<ProjectList>

test('the control origin serves the home page', async () => {
  assert.equal((await fetch(`${CONTROL}/`, { redirect: 'manual' })).status, 404, 'the control root is no landing page')
  const page = await fetch(`${CONTROL}/__ezdesign/home`)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.match(await page.text(), new RegExp(`<script src="/__ezdesign/home.js" data-version="${PKG_VERSION}">`))
})

test('a folder added by any path inside it lists its project, and hides again', async () => {
  const dir = project()
  mkdirSync(join(dir, 'src'))
  const added = (await (await post(API, { path: join(dir, 'src') })).json()) as ProjectRow
  assert.deepEqual(added, { project: dir, name: dir.split('/').at(-1), usedAt: added.usedAt, exists: true, session: null })
  assert.equal((await list()).projects.some((p) => p.project === dir), true)

  assert.equal((await post(`${API}/hide`, { project: dir })).status, 200)
  assert.equal((await list()).projects.some((p) => p.project === dir), false)
  assert.equal((await post(API, { path: 'relative/path' })).status, 400)
})

test('opening starts the dev server and answers with the shell', async () => {
  const dir = project()
  await post(API, { path: dir })
  const opened = (await (await post(`${API}/open`, { project: dir, host: 'browser' })).json()) as { project: string; shellUrl: string }
  assert.equal(opened.project, dir)
  const port = Number(new URL(opened.shellUrl).port)
  const running = await waitFor(async () => {
    const row = (await list()).projects.find((p) => p.project === dir)
    return row?.session?.devServer.phase === 'running' ? row : null
  }, 'the dev server to run')
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'hello')

  const state = (await world.state(port)) as { acp?: unknown; agentOnline: boolean }
  assert.deepEqual([state.acp, state.agentOnline], [undefined, false], 'an agent waits to be connected from the shell')

  const sessionApi = `http://127.0.0.1:${port}/__ezdesign/api/projects`
  assert.equal((await fetch(sessionApi, { headers: VERSIONED })).status, 404, 'a review cannot reach other projects')

  assert.equal((await post(`${API}/stop`, { project: dir })).status, 200)
  assert.equal((await list()).projects.find((p) => p.project === dir)?.session?.devServer.phase, 'stopped')
})

test('only listed projects open', async () => {
  const res = await post(`${API}/open`, { project: '/etc', host: 'browser' })
  assert.equal(res.status, 404)
})

test('a CLI open lists the project', async () => {
  const dir = project()
  assert.equal((await list()).projects.some((p) => p.project === dir), false)
  await world.openSession(daemon.port, { project: dir })
  assert.equal((await list()).projects.some((p) => p.project === dir), true)
})

test('other sites and other builds are refused', async () => {
  const site = await post(API, { path: '/tmp' }, { ...VERSIONED, origin: 'https://example.com', 'sec-fetch-site': 'cross-site' })
  assert.equal(site.status, 403)
  const stale = await fetch(API, { headers: { 'x-ezdesign-version': '0.0.1' } })
  assert.equal(stale.status, 409)
})

test('the live list carries the version, for a page that has no header to send', async () => {
  const res = await fetch(`${API}/events`, { signal: AbortSignal.timeout(2000) })
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  await reader.cancel()
  const first = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '')) as ProjectList
  assert.equal(first.version, PKG_VERSION)
})
