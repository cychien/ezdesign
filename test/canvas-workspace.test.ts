import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import type { CanvasId, ShellView, TabId, ViewStore } from '../src/canvas/types.js'
import { type CanvasChange, type CanvasWorkspace, openCanvasWorkspace } from '../src/canvas/workspace.js'

class MemoryView implements ViewStore {
  view: ShellView = {}
  setActiveTab(tab: TabId): void {
    this.view = { ...this.view, activeTab: tab }
  }
  setCamera(canvasId: CanvasId, camera: { x: number; y: number; zoom: number }): void {
    this.view = { ...this.view, cameras: { ...this.view.cameras, [canvasId]: camera } }
  }
  forgetCamera(canvasId: CanvasId): void {
    const { [canvasId]: _gone, ...cameras } = this.view.cameras ?? {}
    this.view = { ...this.view, cameras }
  }
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12)
const servedRev = (fileHash: string, assets = 'k1') => sha1(`${fileHash}:${assets}`)

function setup(opts: { app?: boolean; now?: () => number } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'ezdesign-canvas-'))
  const view = new MemoryView()
  const changes: CanvasChange[] = []
  let app = opts.app ?? false
  let assets = 'k1'
  const workspace: CanvasWorkspace = openCanvasWorkspace({
    project,
    view,
    frameOrigin: () => 'http://localhost:5000',
    overlay: () => ({ assets, shellOrigin: 'http://127.0.0.1:5000' }),
    hasApp: () => app,
    onChange: (change) => changes.push(change),
    ...(opts.now ? { now: opts.now } : {}),
  })
  workspace.start()
  const root = join(project, '.ezdesign', 'canvases')
  const tree = () => {
    const out: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          out.push(`${relative(root, path)}/`)
          walk(path)
        } else out.push(relative(root, path))
      }
    }
    try {
      walk(root)
    } catch {
      /* no canvases yet */
    }
    return out
  }
  return {
    project,
    view,
    changes,
    workspace,
    root,
    tree,
    setApp: (on: boolean) => (app = on),
    rebuildOverlay: (key: string) => (assets = key),
  }
}

const unwrap = <T>(o: { ok: true; value: T } | { ok: false; problem: unknown }): T => {
  if (!o.ok) throw new Error(`refused: ${JSON.stringify(o.problem)}`)
  return o.value
}

/** A canvas with frames written the way the workspace writes them. */
function seedCanvas(root: string, id: string, name: string, frames: { id: string; html: string }[]) {
  mkdirSync(join(root, id, 'frames'), { recursive: true })
  const rects: Record<string, unknown> = {}
  const manifest = {
    schema: 1,
    id,
    name,
    createdAt: 1,
    frames: frames.map((f, i) => {
      writeFileSync(join(root, id, 'frames', `${f.id}.html`), f.html)
      rects[f.id] = { x: i * 500, y: 0, width: 400, height: 300 }
      return { id: f.id, title: `T${i}`, file: `frames/${f.id}.html`, hash: 'stale0000000', createdAt: 1 }
    }),
  }
  writeFileSync(join(root, id, 'layout.json'), JSON.stringify({ schema: 1, rects }))
  writeFileSync(join(root, id, 'canvas.json'), JSON.stringify(manifest))
}

const DOC = '<!doctype html>\n<html><body>\n<h1>hi</h1>\n</body></html>'

test('CV-tab-persist: the lifecycle leaves exactly the expected files', () => {
  const { workspace, tree, root } = setup()
  const created = unwrap(workspace.user.create('首頁'))
  const id = created.id
  // Closing the only open canvas opens a fresh one; this canvas's files are what count.
  const own = () => tree().filter((f) => f.startsWith(`${id}/`))
  assert.deepEqual(own(), [`${id}/`, `${id}/canvas.json`, `${id}/frames/`, `${id}/layout.json`])
  const manifest = () => JSON.parse(readFileSync(join(root, id, 'canvas.json'), 'utf8'))
  assert.equal(manifest().name, '首頁')

  const before = manifest()
  unwrap(workspace.user.rename(id, '首頁 v2'))
  assert.deepEqual(manifest(), { ...before, name: '首頁 v2' })

  assert.equal(unwrap(workspace.user.archive(id)), 'archived')
  assert.equal(typeof manifest().archivedAt, 'number')
  assert.deepEqual(own(), [`${id}/`, `${id}/canvas.json`, `${id}/frames/`, `${id}/layout.json`])
  assert.equal(workspace.read.inventory().canvases.filter((c) => !c.archived).length, 1)
  unwrap(workspace.user.reopen(id))
  assert.equal(manifest().archivedAt, undefined)

  unwrap(workspace.user.archive(id))
  unwrap(workspace.user.delete(id))
  assert.deepEqual(own(), [])

  const first = unwrap(workspace.user.create('一'))
  const second = unwrap(workspace.user.create('二'))
  unwrap(workspace.user.archive(first.id))
  const summaries = workspace.read.inventory().canvases.map((c) => [c.name, c.archived])
  assert.deepEqual(summaries.slice(-2), [
    ['一', true],
    ['二', false],
  ])
  assert.ok(!tree().some((f) => f.endsWith('.tmp') || f.includes('.tmp-') || f === 'index.json'))
  assert.equal(second.name, '二')
})

test('canvases made in one millisecond keep the order they were made in', () => {
  const { workspace } = setup({ now: () => 1_000 })
  const names = ['一', '二', '三', '四', '五', '六']
  for (const name of names) unwrap(workspace.user.create(name))
  assert.deepEqual(
    workspace.read.inventory().canvases.map((c) => c.name),
    names,
  )
})

test('a restore writes nothing; the first shell to connect gets an empty canvas', () => {
  const { workspace, tree, view } = setup()
  assert.deepEqual(tree(), [])
  assert.equal(workspace.read.snapshot(false).activeTab, null)
  workspace.shellConnected()
  const [only] = workspace.read.inventory().canvases
  assert.equal(only?.name, '未命名 canvas')
  assert.equal(view.view.activeTab, only?.id)
  workspace.shellConnected()
  assert.equal(workspace.read.inventory().canvases.length, 1)
})

test('with an app attached the empty start makes nothing and the App tab shows', () => {
  const { workspace, tree } = setup({ app: true })
  workspace.shellConnected()
  assert.deepEqual(tree(), [])
  assert.equal(workspace.read.snapshot(false).activeTab, 'app')
})

test('closing an empty untitled canvas deletes it; closing the active one moves to its neighbour', () => {
  const { workspace, view, tree } = setup({ app: true })
  const blank = unwrap(workspace.user.create())
  assert.equal(blank.name, '未命名 canvas')
  assert.equal(unwrap(workspace.user.create()).name, '未命名 canvas 2')
  assert.equal(unwrap(workspace.user.archive(blank.id)), 'deleted')
  assert.ok(!tree().some((f) => f.startsWith(blank.id)))

  const a = unwrap(workspace.user.create('A'))
  const b = unwrap(workspace.user.create('B'))
  workspace.user.setView({ activeTab: a.id })
  unwrap(workspace.user.archive(a.id))
  assert.equal(view.view.activeTab, b.id, 'the next open tab')
  unwrap(workspace.user.archive(b.id))
  assert.notEqual(view.view.activeTab, b.id)
})

test('deleting an open canvas removes its frames and moves the active tab off it', () => {
  const { workspace, view, tree } = setup()
  const a = unwrap(workspace.user.create('A'))
  const b = unwrap(workspace.user.create('B'))
  unwrap(workspace.agent.addFrame({ canvasId: a.id, title: 'x', html: DOC, size: {} }))
  assert.ok(tree().some((f) => f.startsWith(`${a.id}/frames/`) && f.endsWith('.html')))
  workspace.user.setView({ activeTab: a.id })
  unwrap(workspace.user.delete(a.id))
  assert.ok(!tree().some((f) => f.startsWith(a.id)))
  assert.equal(view.view.activeTab, b.id)
  unwrap(workspace.user.delete(b.id))
  const left = workspace.read.inventory().canvases
  assert.equal(left.length, 1, 'the strip is never empty: a fresh canvas opens')
  assert.equal(view.view.activeTab, left[0]!.id)
})

test('the App tab leaving with no canvas open opens an empty one only while a shell watches', () => {
  const ctx = setup({ app: true })
  ctx.view.setActiveTab('app')
  ctx.setApp(false)
  ctx.workspace.appChanged({ show: false, create: false })
  assert.deepEqual(ctx.tree(), [])
  ctx.workspace.appChanged({ show: false, create: true })
  assert.equal(ctx.workspace.read.inventory().canvases.length, 1)
  ctx.setApp(true)
  ctx.workspace.appChanged({ show: true, create: true })
  assert.equal(ctx.view.view.activeTab, 'app')
})

// The overlay is cached as immutable under its url. A rebuild that kept the url
// would leave every frame running the old overlay until the cache expired.
test('a rebuilt overlay gives every frame a new url and a document that loads it', () => {
  const { workspace, root, rebuildOverlay } = setup()
  seedCanvas(root, 'aaaaaaaaaaaa', 'seeded', [{ id: 'bbbbbbbbbbbb', html: DOC }])
  workspace.start()
  const frame = () => workspace.read.frameDocument('aaaaaaaaaaaa' as CanvasId, 'bbbbbbbbbbbb' as never)!
  const src = () => workspace.read.wire('aaaaaaaaaaaa' as CanvasId)!.frames[0]!.src
  const before = { doc: frame(), src: src() }
  assert.match(before.doc.html, /overlay\.js\?v=k1"/)

  rebuildOverlay('k2')
  const after = frame()
  assert.notEqual(src(), before.src)
  assert.equal(src().endsWith(`?rev=${after.hash}`), true, 'the url names the document it gets')
  assert.match(after.html, /overlay\.js\?v=k2"/)
  assert.equal(workspace.read.wire('aaaaaaaaaaaa' as CanvasId)!.frames[0]!.hash, sha1(DOC), 'the file did not change')
})

test('a frame is served stamped with its file and line, and an outside edit moves its hash', () => {
  const { workspace, root, changes } = setup()
  seedCanvas(root, 'aaaaaaaaaaaa', 'seeded', [{ id: 'bbbbbbbbbbbb', html: DOC }])
  workspace.start()
  const wire = workspace.read.wire('aaaaaaaaaaaa' as CanvasId)!
  const hash = sha1(DOC)
  assert.equal(wire.frames[0]!.hash, hash, 'start re-hashes what was edited while down')
  assert.equal(
    wire.frames[0]!.src,
    `http://localhost:5000/__ezdesign/frames/aaaaaaaaaaaa/bbbbbbbbbbbb?rev=${servedRev(hash)}`,
  )
  assert.equal(wire.frames[0]!.file, '.ezdesign/canvases/aaaaaaaaaaaa/frames/bbbbbbbbbbbb.html')

  const doc = workspace.read.frameDocument('aaaaaaaaaaaa' as CanvasId, 'bbbbbbbbbbbb' as never)!
  assert.match(doc.html, /<h1 data-ez-source="\.ezdesign\/canvases\/aaaaaaaaaaaa\/frames\/bbbbbbbbbbbb\.html:3">hi<\/h1>/)
  assert.match(doc.html, /data-ez-link="relay" data-ez-shell="http:\/\/127\.0\.0\.1:5000"/)

  const edited = DOC.replace('hi', 'edited')
  writeFileSync(join(root, 'aaaaaaaaaaaa', 'frames', 'bbbbbbbbbbbb.html'), edited)
  changes.length = 0
  const again = workspace.read.frameDocument('aaaaaaaaaaaa' as CanvasId, 'bbbbbbbbbbbb' as never)!
  assert.equal(again.hash, servedRev(sha1(edited)))
  assert.deepEqual(changes, [{ kind: 'updated', canvasId: 'aaaaaaaaaaaa' }])
  assert.equal(workspace.read.hasFrame({ canvasId: 'aaaaaaaaaaaa', frameId: 'bbbbbbbbbbbb' }), true)
  assert.equal(workspace.read.hasFrame({ canvasId: 'aaaaaaaaaaaa', frameId: 'cccccccccccc' }), false)
  assert.deepEqual(workspace.read.names({ canvasId: 'aaaaaaaaaaaa', frameId: 'bbbbbbbbbbbb' }), {
    canvas: 'seeded',
    frame: 'T0',
  })
})

test("CV-auto-place: each of the agent's turns adds its frames as one row, left to right", () => {
  const { workspace } = setup()
  const canvasId = unwrap(workspace.agent.create('brand')).id
  const turns = [[700, 820, 820, 820, 820], [980, 820, 820, 820], [1080, 620, 620, 620]]
  const rows = turns.map((heights) => {
    workspace.beginTurn()
    return heights.map((height) => {
      const frame = unwrap(workspace.agent.addFrame({ canvasId, title: 'f', html: DOC, size: { width: 1280, height } }))
      return [frame.rect.x, frame.rect.y]
    })
  })
  assert.deepEqual(rows, [
    [[0, 0], [1360, 0], [2720, 0], [4080, 0], [5440, 0]],
    [[0, 1060], [1360, 1060], [2720, 1060], [4080, 1060]],
    [[0, 2280], [1360, 2280], [2720, 2280], [4080, 2280]],
  ])
})

test('a manifest from a newer version is left alone, and unnamed old files are swept', () => {
  const { workspace, root } = setup()
  mkdirSync(join(root, 'dddddddddddd'), { recursive: true })
  const future = JSON.stringify({ schema: 2, id: 'dddddddddddd' })
  writeFileSync(join(root, 'dddddddddddd', 'canvas.json'), future)
  seedCanvas(root, 'aaaaaaaaaaaa', 'seeded', [{ id: 'bbbbbbbbbbbb', html: DOC }])
  const stray = join(root, 'aaaaaaaaaaaa', 'frames', 'eeeeeeeeeeee.html')
  const fresh = join(root, 'aaaaaaaaaaaa', 'frames', 'ffffffffffff.html')
  writeFileSync(stray, DOC)
  writeFileSync(fresh, DOC)
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  utimesSync(stray, old, old)
  workspace.start()
  assert.deepEqual(workspace.read.inventory().canvases.map((c) => c.id), ['aaaaaaaaaaaa'])
  assert.equal(readFileSync(join(root, 'dddddddddddd', 'canvas.json'), 'utf8'), future)
  assert.deepEqual(readdirSync(join(root, 'aaaaaaaaaaaa', 'frames')).sort(), ['bbbbbbbbbbbb.html', 'ffffffffffff.html'])
})

test('names and views are checked at the door', () => {
  const { workspace, view } = setup()
  const bad = workspace.user.create('x'.repeat(61))
  assert.equal(!bad.ok && bad.problem.code, 'BAD_NAME')
  const unknown = workspace.user.rename('000000000000', 'x')
  assert.equal(!unknown.ok && unknown.problem.code, 'CANVAS_NOT_FOUND')
  const c = unwrap(workspace.user.create('c'))
  workspace.user.setView({ activeTab: 'app' })
  assert.equal(view.view.activeTab, c.id, 'no App tab to switch to')
  workspace.user.setView({ camera: { canvasId: c.id, camera: { x: 1, y: 2, zoom: 0.5 } } })
  assert.deepEqual(workspace.read.wire(c.id)!.camera, { x: 1, y: 2, zoom: 0.5 })
})

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('a pasted image is stored once by its bytes and shown by a frame the daemon writes', () => {
  const { workspace, root, changes } = setup()
  const canvas = unwrap(workspace.user.create('貼圖'))
  const asset = unwrap(workspace.user.addAsset(canvas.id, 'image/png', PNG))
  assert.equal(asset, '22f545ac6b50.png')
  assert.equal(unwrap(workspace.user.addAsset(canvas.id, 'image/png', PNG)), asset)
  assert.deepEqual(readdirSync(join(root, canvas.id, 'frames', 'assets')), [asset])
  assert.deepEqual(workspace.read.asset(canvas.id, asset), { path: join(root, canvas.id, 'frames', 'assets', asset), mime: 'image/png' })

  changes.length = 0
  const input = { id: 'a1a1a1a1a1a1', asset, title: 'image', rect: { x: -200.4, y: 10, width: 640, height: 480 } } as const
  const wire = unwrap(workspace.user.addImageFrame(canvas.id, input as never))
  assert.deepEqual(changes, [{ kind: 'updated', canvasId: canvas.id }])
  const frame = wire.frames.find((f) => f.id === 'a1a1a1a1a1a1')!
  assert.deepEqual(frame.rect, { x: -200, y: 10, width: 640, height: 480 })
  assert.equal(frame.title, 'image')
  assert.equal(
    readFileSync(join(root, canvas.id, 'frames', 'a1a1a1a1a1a1.html'), 'utf8'),
    [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      '<title>image</title>',
      '<style>html,body{margin:0;height:100%}img{display:block;width:100%;height:100%;object-fit:contain}</style>',
      '</head>',
      '<body>',
      `<img src="assets/${asset}" alt="image">`,
      '</body>',
      '</html>',
      '',
    ].join('\n'),
  )
  const again = unwrap(workspace.user.addImageFrame(canvas.id, input as never))
  assert.equal(again.frames.length, 1, 'a retried paste creates nothing twice')
})

test('an image is refused for its type, size or a missing file, and nothing is written', () => {
  const { workspace, root } = setup()
  const canvas = unwrap(workspace.user.create('貼圖'))
  const refused = (o: { ok: boolean; problem?: unknown }) => (o.ok ? null : o.problem)
  assert.deepEqual(refused(workspace.user.addAsset(canvas.id, 'text/html', PNG)), { code: 'IMAGE_UNSUPPORTED', mime: 'text/html' })
  assert.deepEqual(refused(workspace.user.addAsset(canvas.id, 'image/png', Buffer.alloc(0))), { code: 'IMAGE_EMPTY' })
  const huge = Buffer.alloc(20 * 1024 * 1024 + 1)
  assert.deepEqual(refused(workspace.user.addAsset(canvas.id, 'image/png', huge)), {
    code: 'IMAGE_TOO_LARGE',
    bytes: 20 * 1024 * 1024 + 1,
    limit: 20 * 1024 * 1024,
  })
  const input = { id: 'a1a1a1a1a1a1', asset: 'cccccccccccc.png', title: 'image', rect: { x: 0, y: 0, width: 400, height: 300 } }
  assert.deepEqual(refused(workspace.user.addImageFrame(canvas.id, input as never)), {
    code: 'ASSET_NOT_FOUND',
    canvasId: canvas.id,
    asset: 'cccccccccccc.png',
  })
  assert.deepEqual(readdirSync(join(root, canvas.id, 'frames')), [])
  assert.equal(workspace.read.asset(canvas.id, 'cccccccccccc.png' as never), null)
})

test('the sweep keeps images a frame shows and collects old ones none does', () => {
  const { workspace, root } = setup()
  seedCanvas(root, 'aaaaaaaaaaaa', 'seeded', [
    { id: 'bbbbbbbbbbbb', html: '<!doctype html><html><body><img src="assets/111111111111.png"></body></html>' },
  ])
  const assets = join(root, 'aaaaaaaaaaaa', 'frames', 'assets')
  mkdirSync(assets)
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  for (const name of ['111111111111.png', '222222222222.png', '333333333333.png']) writeFileSync(join(assets, name), PNG)
  utimesSync(join(assets, '111111111111.png'), old, old)
  utimesSync(join(assets, '222222222222.png'), old, old)
  workspace.start()
  assert.deepEqual(readdirSync(assets).sort(), ['111111111111.png', '333333333333.png'])
  assert.deepEqual(readdirSync(join(root, 'aaaaaaaaaaaa', 'frames')).sort(), ['assets', 'bbbbbbbbbbbb.html'])
})
