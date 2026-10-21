import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CANVAS_TOOL_NAMES, isCanvasTool, runCanvasTool } from '../src/canvas/mcp.js'
import { canvasBrief } from '../src/canvas/prompt.js'
import type { CanvasId, ShellView, TabId, ViewStore } from '../src/canvas/types.js'
import { openCanvasWorkspace } from '../src/canvas/workspace.js'

class MemoryView implements ViewStore {
  view: ShellView = {}
  setActiveTab(tab: TabId): void {
    this.view = { ...this.view, activeTab: tab }
  }
  setCamera(): void {}
  forgetCamera(): void {}
}

function setup() {
  const project = mkdtempSync(join(tmpdir(), 'ezdesign-mcp-'))
  const view = new MemoryView()
  const workspace = openCanvasWorkspace({
    project,
    view,
    frameOrigin: () => 'http://localhost:5000',
    overlay: () => ({ version: '1', shellOrigin: 'http://127.0.0.1:5000' }),
    hasApp: () => true,
    onChange: () => {},
  })
  workspace.start()
  const root = join(project, '.ezdesign', 'canvases')
  /** Every file under the canvases with its hash: what "nothing was written" means. */
  const disk = () => {
    const out: Record<string, string> = {}
    const walk = (dir: string) => {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else out[path] = createHash('sha1').update(readFileSync(path)).digest('hex')
      }
    }
    walk(root)
    return out
  }
  return { project, view, port: workspace.agent, disk }
}

const DOC = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`
const text = (r: { content: { text: string }[] }) => r.content[0]!.text
const value = <T>(r: { structuredContent?: Record<string, unknown> }) => r.structuredContent as T

test('the agent creates a canvas, fills it, and the canvas becomes the active tab', () => {
  const { port, view, project } = setup()
  assert.deepEqual(value(runCanvasTool(port, 'list_canvases', {})), { activeTab: 'app', canvases: [] })
  const made = value<{ canvasId: CanvasId; dir: string }>(runCanvasTool(port, 'create_canvas', { name: 'Design system' }))
  assert.equal(view.view.activeTab, made.canvasId)
  assert.equal(made.dir, `.ezdesign/canvases/${made.canvasId}`)
  const frames = ['Colors', 'Type', 'Buttons'].map((title) =>
    value<{ file: string; hash: string; x: number; y: number; width: number; height: number }>(
      runCanvasTool(port, 'add_frame', { canvasId: made.canvasId, title, html: DOC(title), width: 390 }),
    ),
  )
  for (const f of frames) assert.equal(readFileSync(join(project, f.file), 'utf8').includes('<h1>'), true)
  assert.deepEqual(frames.map((f) => [f.x, f.y, f.width, f.height]), [
    [0, 0, 390, 844],
    [470, 0, 390, 844],
    [940, 0, 390, 844],
  ])
  const read = value<{ frames: { title: string }[] }>(runCanvasTool(port, 'read_canvas', { canvasId: made.canvasId }))
  assert.deepEqual(read.frames.map((f) => f.title), ['Colors', 'Type', 'Buttons'])
})

test('CV-tool-errors: every refusal names its problem and writes nothing', () => {
  const { port, disk } = setup()
  const open = value<{ canvasId: string }>(runCanvasTool(port, 'create_canvas', { name: 'open' })).canvasId
  const closed = value<{ canvasId: string }>(runCanvasTool(port, 'create_canvas', { name: 'closed' })).canvasId
  runCanvasTool(port, 'add_frame', { canvasId: closed, title: 'kept', html: DOC('kept') })
  // Archived the way the user archives: through the workspace on disk.
  const manifest = join(Object.keys(disk()).find((p) => p.includes(closed) && p.endsWith('canvas.json'))!)
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), archivedAt: 1 }))
  const { port: again, disk: diskAgain } = (() => {
    const project = manifest.split('/.ezdesign/')[0]!
    const view = new MemoryView()
    const ws = openCanvasWorkspace({
      project,
      view,
      frameOrigin: () => 'http://localhost:5000',
      overlay: () => ({ version: '1', shellOrigin: 'http://127.0.0.1:5000' }),
      hasApp: () => true,
      onChange: () => {},
    })
    ws.start()
    return { port: ws.agent, disk }
  })()
  const cases: [string, ReturnType<typeof runCanvasTool>, RegExp][] = [
    ['unknown canvas', runCanvasTool(again, 'add_frame', { canvasId: '000000000000', title: 'x', html: DOC('x') }), /^CANVAS_NOT_FOUND: .*Existing: .*\(open\)/],
    ['archived', runCanvasTool(again, 'add_frame', { canvasId: closed, title: 'x', html: DOC('x') }), /^CANVAS_ARCHIVED: .*reopen_canvas/],
    ['too large', runCanvasTool(again, 'add_frame', { canvasId: open, title: 'x', html: `<!doctype html>${'x'.repeat(600 * 1024)}` }), /^HTML_TOO_LARGE: .*the limit is 524288/],
    ['empty', runCanvasTool(again, 'add_frame', { canvasId: open, title: 'x', html: '' }), /^HTML_EMPTY: /],
    ['fragment', runCanvasTool(again, 'add_frame', { canvasId: open, title: 'x', html: '<div>x</div>' }), /^NOT_A_DOCUMENT: /],
    ['unknown frame', runCanvasTool(again, 'update_frame', { canvasId: open, frameId: 'ffffffffffff', html: DOC('y') }), /^FRAME_NOT_FOUND: /],
    ['empty name', runCanvasTool(again, 'create_canvas', { name: '  ' }), /^BAD_NAME: /],
  ]
  const before = diskAgain()
  for (const [label, result, pattern] of cases) {
    assert.equal(result.isError, true, label)
    assert.match(text(result), pattern, label)
  }
  assert.deepEqual(diskAgain(), before)
})

test('CV-tool-errors: a canvas at the frame limit takes no more', () => {
  const { port, disk } = setup()
  const id = value<{ canvasId: string }>(runCanvasTool(port, 'create_canvas', { name: 'full' })).canvasId
  for (let i = 0; i < 200; i++) runCanvasTool(port, 'add_frame', { canvasId: id, title: `f${i}`, html: DOC('f') })
  const before = disk()
  const refused = runCanvasTool(port, 'add_frame', { canvasId: id, title: 'one more', html: DOC('x') })
  assert.match(text(refused), /^TOO_MANY_FRAMES: .*200/)
  assert.deepEqual(disk(), before)
})

test('CV-p5-conflict: an update against a stale hash writes nothing and names the current one', () => {
  const { port, project } = setup()
  const id = value<{ canvasId: string }>(runCanvasTool(port, 'create_canvas', { name: 'c' })).canvasId
  const added = value<{ frameId: string; file: string; hash: string }>(
    runCanvasTool(port, 'add_frame', { canvasId: id, title: 'f', html: DOC('one') }),
  )
  const outside = DOC('edited outside')
  writeFileSync(join(project, added.file), outside)
  const h2 = createHash('sha1').update(outside).digest('hex').slice(0, 12)
  const stale = runCanvasTool(port, 'update_frame', { canvasId: id, frameId: added.frameId, html: DOC('two'), expectedHash: added.hash })
  assert.match(text(stale), new RegExp(`^FRAME_CONFLICT: .*current hash is ${h2}`))
  assert.equal(readFileSync(join(project, added.file), 'utf8'), outside)
  const fresh = value<{ hash: string }>(
    runCanvasTool(port, 'update_frame', { canvasId: id, frameId: added.frameId, html: DOC('two'), expectedHash: h2 }),
  )
  assert.equal(fresh.hash, createHash('sha1').update(DOC('two')).digest('hex').slice(0, 12))
  runCanvasTool(port, 'update_frame', { canvasId: id, frameId: added.frameId, html: DOC('three') })
  assert.equal(readFileSync(join(project, added.file), 'utf8'), DOC('three'))
  const removed = value<{ removed: string }>(runCanvasTool(port, 'remove_frame', { canvasId: id, frameId: added.frameId }))
  assert.equal(removed.removed, added.frameId)
})

test('only this server\'s own tools are auto-granted', () => {
  assert.equal(isCanvasTool('mcp__ezdesign-canvas__add_frame'), true)
  assert.equal(isCanvasTool('mcp__ezdesign-canvas__rm_rf'), false)
  assert.equal(isCanvasTool('mcp__other__add_frame'), false)
  assert.deepEqual(CANVAS_TOOL_NAMES, [
    'list_canvases',
    'create_canvas',
    'read_canvas',
    'reopen_canvas',
    'add_frame',
    'update_frame',
    'remove_frame',
  ])
})

test('the brief says where the user was and what exists, and nothing without tools', () => {
  const inventory = {
    activeTab: 'aaaaaaaaaaaa' as CanvasId,
    canvases: [
      { id: 'aaaaaaaaaaaa' as CanvasId, name: 'A', archived: false, frames: 2, createdAt: 1 },
      { id: 'bbbbbbbbbbbb' as CanvasId, name: 'B', archived: true, frames: 0, createdAt: 2 },
    ],
  }
  const lines = canvasBrief({ inventory, view: { tab: 'canvas', canvasId: 'aaaaaaaaaaaa' }, app: 'http://localhost:5173', tools: true })
  assert.ok(lines.includes('The review shell has these tabs: App (http://localhost:5173), canvas "A" (aaaaaaaaaaaa, 2 frames). Archived: "B" (bbbbbbbbbbbb).'))
  assert.ok(lines.includes('The user was on canvas "A" (aaaaaaaaaaaa) when they sent this.'))
  assert.ok(lines.some((l) => l.includes('Never edit canvas.json or layout.json.')))
  assert.ok(lines.some((l) => l.includes('list_canvases, create_canvas, read_canvas')))
  const app = canvasBrief({ inventory, view: { tab: 'app', page: '/pricing' }, app: 'http://localhost:5173', tools: true })
  assert.ok(app.includes('The user was on the App tab at /pricing when they sent this.'))
  assert.deepEqual(canvasBrief({ inventory, view: undefined, app: null, tools: false }), [])
})
