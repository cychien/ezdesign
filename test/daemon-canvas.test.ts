import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld } from './helpers/daemon.js'

const worlds: DaemonWorld[] = []
after(() => Promise.all(worlds.map((w) => w.dispose())))

const CANVAS = 'aaaaaaaaaaaa'
const FRAME = 'bbbbbbbbbbbb'
const DOC = '<!doctype html>\n<html><body>\n<h1>hi</h1>\n</body></html>'

function project(world: DaemonWorld, seeded: boolean): string {
  const dir = realpathSync(mkdtempSync(join(world.dataDir, 'project-')))
  writeFileSync(join(dir, 'package.json'), '{}')
  if (seeded) {
    const root = join(dir, '.ezdesign', 'canvases', CANVAS)
    mkdirSync(join(root, 'frames'), { recursive: true })
    writeFileSync(join(root, 'frames', `${FRAME}.html`), DOC)
    writeFileSync(
      join(root, 'layout.json'),
      JSON.stringify({ schema: 1, rects: { [FRAME]: { x: 0, y: 0, width: 400, height: 300 } } }),
    )
    writeFileSync(
      join(root, 'canvas.json'),
      JSON.stringify({
        schema: 1,
        id: CANVAS,
        name: '首頁探索',
        createdAt: 1,
        frames: [{ id: FRAME, title: 'Hero A', file: `frames/${FRAME}.html`, hash: 'x', createdAt: 1 }],
      }),
    )
  }
  return dir
}

async function world(canvas: boolean): Promise<{ world: DaemonWorld; control: number }> {
  const w = await DaemonWorld.create()
  worlds.push(w)
  if (canvas) w.env.EZDESIGN_CANVAS = '1'
  w.spawnDaemon()
  return { world: w, control: (await w.liveDaemon()).port }
}

/** A GET with a chosen `Host`, which `fetch` will not send. */
function get(port: number, host: string, path: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** The first flush of a shell's event stream, as text. */
async function firstFlush(port: number): Promise<string> {
  const controller = new AbortController()
  const res = await fetch(`http://127.0.0.1:${port}/__ezdesign/api/events?shell=1`, { signal: controller.signal })
  const reader = res.body!.getReader()
  let text = ''
  while (!text.includes('data: {"version"')) text += new TextDecoder().decode((await reader.read()).value)
  controller.abort()
  return text
}

test('CV-p4-flag-off: without the flag nothing of the canvas exists', async () => {
  const { world: w, control } = await world(false)
  const dir = project(w, true)
  const { port } = await w.openSession(control, { url: 'http://127.0.0.1:9/', project: dir })
  const state = await w.state(port)
  assert.equal('canvas' in state, false)
  assert.equal((await get(port, `localhost:${port}`, `/__ezdesign/frames/${CANVAS}/${FRAME}`)).status, 404)
  assert.equal((await get(port, `127.0.0.1:${port}`, `/__ezdesign/frames/${CANVAS}/${FRAME}`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/__ezdesign/api/canvases/${CANVAS}`)).status, 404)
})

test('frames are served on the frame host only, stamped, with the relay overlay', async () => {
  const { world: w, control } = await world(true)
  const dir = project(w, true)
  const { port } = await w.openSession(control, { url: 'http://127.0.0.1:9/', project: dir })
  const flush = await firstFlush(port)
  assert.ok(flush.indexOf('event: canvas\n') < flush.indexOf('data: {"version"'), 'canvases before the snapshot')
  const wire = JSON.parse(/event: canvas\ndata: (.*)\n/.exec(flush)![1]!).canvas
  assert.equal(wire.name, '首頁探索')
  const src = new URL(wire.frames[0].src)
  assert.equal(src.host, `localhost:${port}`)

  const served = await get(port, src.host, `${src.pathname}${src.search}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal(served.headers['x-content-type-options'], 'nosniff')
  assert.match(served.body, new RegExp(`<h1 data-ez-source="\\.ezdesign/canvases/${CANVAS}/frames/${FRAME}\\.html:3">hi</h1>`))
  assert.match(served.body, new RegExp(`data-ez-link="relay" data-ez-shell="http://127\\.0\\.0\\.1:${port}"`))

  assert.equal((await get(port, `127.0.0.1:${port}`, src.pathname)).status, 404, 'never on the shell origin')
  const elsewhere = await get(port, src.host, '/__ezdesign/shell')
  assert.equal(elsewhere.status, 404)
  assert.match(elsewhere.body, new RegExp(`http://127\\.0\\.0\\.1:${port}/__ezdesign/shell`))
  assert.equal((await get(port, src.host, '/__ezdesign/api/state')).status, 404)
})

test('an annotation must name a frame that exists', async () => {
  const { world: w, control } = await world(true)
  const dir = project(w, true)
  const { port } = await w.openSession(control, { url: 'http://127.0.0.1:9/', project: dir })
  const post = (frame: unknown) =>
    fetch(`http://127.0.0.1:${port}/__ezdesign/api/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'element', comment: 'x', anchor: { selector: 'h1', frame } }),
    })
  const unknown = await post({ canvasId: CANVAS, frameId: 'cccccccccccc' })
  assert.equal(unknown.status, 400)
  assert.deepEqual(await unknown.json(), { error: 'unknown canvas frame' })
  assert.equal((await post({ canvasId: CANVAS, frameId: FRAME })).status, 200)
})

test('the shell routes run the lifecycle, and the empty start waits for a shell', async () => {
  const { world: w, control } = await world(true)
  const dir = project(w, false)
  const opened = await w.openSession(control, { project: dir })
  assert.equal(opened.shellUrl, `http://127.0.0.1:${opened.port}/__ezdesign/shell`)
  const before = (await w.state(opened.port)) as { canvas: { canvases: unknown[]; activeTab: unknown } }
  assert.deepEqual(before.canvas.canvases, [])
  assert.equal(before.canvas.activeTab, null)
  assert.deepEqual(readdirSync(dir), ['package.json'], 'nothing written before a shell connects')

  await firstFlush(opened.port)
  const after = (await w.state(opened.port)) as { canvas: { canvases: { id: string; name: string }[]; activeTab: string } }
  assert.deepEqual(after.canvas.canvases.map((c) => c.name), ['未命名 canvas'])
  assert.equal(after.canvas.activeTab, after.canvas.canvases[0]!.id)

  const api = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${opened.port}/__ezdesign/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json' },
    })
  const made = (await (await api('/canvases', { method: 'POST', body: JSON.stringify({ name: '首頁' }) })).json()) as { id: string; name: string }
  assert.equal(made.name, '首頁')
  assert.equal((await api(`/canvases/${made.id}`, { method: 'DELETE' })).status, 409)
  assert.deepEqual(await (await api(`/canvases/${made.id}/archive`, { method: 'POST' })).json(), { result: 'archived' })
  assert.deepEqual(await (await api(`/canvases/${made.id}`, { method: 'DELETE' })).json(), { ok: true })
  assert.equal((await api('/view', { method: 'PUT', body: JSON.stringify({ activeTab: 'nope' }) })).status, 400)

  const status = await w.run(['status'], { cwd: dir })
  assert.match(status.stdout, /canvases: 1 open/)
})
