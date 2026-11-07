import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AssetName, CanvasId, FrameId, FrameKind, Rect, ShellView, TabId, ViewStore } from '../src/canvas/types.js'
import type { CanvasWire, FrameWire, LayoutOp, OpId } from '../src/canvas/wire.js'
import { openCanvasWorkspace } from '../src/canvas/workspace.js'
import { parseLayoutStep, parsePaste } from '../src/canvas/routes.js'
import { snapMove } from '../src/client/canvas/guides.js'
import {
  EditHistory,
  HISTORY_LIMIT,
  NUDGE_FOLD_MS,
  planCopies,
  planImages,
  planMove,
  planRemove,
  planResize,
  withPending,
} from '../src/client/canvas/history.js'

const id = (n: number) => n.toString(16).padStart(12, '0') as FrameId
const frame = (n: number, rect: Rect, kind: FrameKind = 'page'): FrameWire => ({
  id: id(n),
  title: `f${n}`,
  kind,
  rect,
  file: `f${n}.html`,
  hash: `h${n}`,
  src: `src${n}`,
})
const canvasOf = (frames: FrameWire[]): CanvasWire => ({ id: 'cccccccccccc' as CanvasId, name: 'c', archived: false, createdAt: 1, frames })

/** The board's own model: apply ops the way the daemon does, skipping gone frames. */
function applyOps(frames: FrameWire[], ops: LayoutOp[], removed: Map<FrameId, FrameWire>): FrameWire[] {
  return withPending(canvasOf(frames), [{ t: 'ops', ops }]).concat(
    ops.flatMap((op) => (op.t === 'restore' ? op.ids.map((i) => removed.get(i)).filter((f): f is FrameWire => !!f) : [])),
  )
}

test('CV-p6-history: undo all and redo all land exactly on the literals', () => {
  const start = [frame(1, { x: 0, y: 0, width: 400, height: 300 }), frame(2, { x: 500, y: 0, width: 400, height: 300 }), frame(3, { x: 1000, y: 0, width: 400, height: 300 })]
  let frames = start
  const removed = new Map<FrameId, FrameWire>()
  const history = new EditHistory()
  const run = (step: ReturnType<typeof planMove>, at: number) => {
    history.push(step, at)
    for (const edit of step.apply) if (edit.t === 'ops') {
      for (const op of edit.ops) if (op.t === 'remove') for (const i of op.ids) removed.set(i, frames.find((f) => f.id === i)!)
      frames = applyOps(frames, edit.ops, removed)
    }
  }
  run(planMove(frames, new Set([id(1)]), 100, 50), 0)
  run(planMove(frames, new Set([id(1), id(2), id(3)]), -10, 20), 2000)
  run(planRemove(new Set([id(3)])), 3000)
  const end = frames.map((f) => [f.id, f.rect])
  assert.deepEqual(end, [
    [id(1), { x: 90, y: 70, width: 400, height: 300 }],
    [id(2), { x: 490, y: 20, width: 400, height: 300 }],
  ])
  for (let ops = history.undo(); ops; ops = history.undo()) frames = applyOps(frames, ops, removed)
  assert.deepEqual(frames.map((f) => [f.id, f.rect]).sort(), start.map((f) => [f.id, f.rect]).sort())
  for (let ops = history.redo(); ops; ops = history.redo()) {
    for (const op of ops) if (op.t === 'remove') for (const i of op.ids) removed.set(i, frames.find((f) => f.id === i)!)
    frames = applyOps(frames, ops, removed)
  }
  assert.deepEqual(frames.map((f) => [f.id, f.rect]), end)
})

test('CV-p6-history: nudges fold within the window, and the stack is bounded', () => {
  const frames = [frame(1, { x: 0, y: 0, width: 400, height: 300 })]
  const history = new EditHistory()
  history.push(planMove(frames, new Set([id(1)]), 1, 0, { nudge: true }), 0)
  const moved = [frame(1, { x: 1, y: 0, width: 400, height: 300 })]
  history.push(planMove(moved, new Set([id(1)]), 1, 0, { nudge: true }), NUDGE_FOLD_MS - 1)
  assert.deepEqual(history.undo(), [{ t: 'move', frames: [{ id: id(1), x: 0, y: 0 }] }])
  assert.equal(history.canUndo, false, 'two quick nudges were one step')
  history.redo()
  history.push(planMove(moved, new Set([id(1)]), 1, 0, { nudge: true }), 10 * NUDGE_FOLD_MS)
  history.undo()
  assert.equal(history.canUndo, true, 'a late nudge is its own step')
  const long = new EditHistory()
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) long.push(planMove(frames, new Set([id(1)]), i, 0), i * 1000)
  let count = 0
  while (long.undo()) count++
  assert.equal(count, HISTORY_LIMIT)
})

test('a duplicate in flight shows beside its source, and copies of a selection do not stack', () => {
  const frames = [frame(1, { x: 0, y: 0, width: 400, height: 300 }), frame(2, { x: 0, y: 1000, width: 400, height: 300 })]
  let n = 100
  const step = planCopies(frames, canvasOf(frames).id, frames, 'beside', () => id(n++), '複製')
  assert.deepEqual(step.copies, [id(100), id(101)])
  assert.equal(step.label, '複製 2 個 frame')
  assert.deepEqual(step.apply.map((e) => e.t === 'paste' && e.input), [
    {
      from: canvasOf(frames).id,
      frames: [
        { from: id(1), id: id(100), at: { x: 480, y: 0 } },
        { from: id(2), id: id(101), at: { x: 480, y: 1000 } },
      ],
    },
  ], 'one request for the whole selection, naming frames and never their documents')
  const shown = withPending(canvasOf(frames), step.apply)
  assert.deepEqual(shown.map((f) => [f.id, f.rect.x, f.rect.y, f.src]), [
    [id(1), 0, 0, 'src1'],
    [id(2), 0, 1000, 'src2'],
    [id(100), 480, 0, 'src1'],
    [id(101), 480, 1000, 'src2'],
  ])
  assert.deepEqual(step.undo, [{ t: 'remove', ids: [id(100), id(101)] }])
})

test('a paste onto another canvas lands as a group centred on the view, in the arrangement it was copied in', () => {
  const copied = [frame(1, { x: 0, y: 0, width: 400, height: 300 }), frame(2, { x: 600, y: 100, width: 200, height: 500 })]
  const onto = [frame(9, { x: 5000, y: 5000, width: 100, height: 100 })]
  let n = 100
  const step = planCopies(copied, 'aaaaaaaaaaaa' as CanvasId, onto, { x: 1000, y: 1000 }, () => id(n++), '貼上')
  assert.equal(step.label, '貼上 2 個 frame')
  const shown = withPending(canvasOf(onto), step.apply)
  // The group is 800 x 600, so its corner goes to (600, 700); each keeps its offset in it.
  assert.deepEqual(shown.map((f) => [f.id, f.rect, f.src]), [
    [id(9), { x: 5000, y: 5000, width: 100, height: 100 }, 'src9'],
    [id(100), { x: 600, y: 700, width: 400, height: 300 }, 'src1'],
    [id(101), { x: 1200, y: 800, width: 200, height: 500 }, 'src2'],
  ], 'drawn from the copied frames at once, before the daemon answers')
  assert.deepEqual(step.redo, [{ t: 'restore', ids: [id(100), id(101)] }])
})

test('a paste aimed over frames already there slides along the row to the first clear spot', () => {
  const copied = [frame(1, { x: 0, y: 0, width: 400, height: 300 })]
  const onto = [frame(9, { x: 0, y: 0, width: 1000, height: 1000 })]
  const step = planCopies(copied, 'aaaaaaaaaaaa' as CanvasId, onto, { x: 500, y: 500 }, () => id(100), '貼上')
  const pasted = withPending(canvasOf(onto), step.apply).find((f) => f.id === id(100))!
  assert.deepEqual(pasted.rect, { x: 1080, y: 350, width: 400, height: 300 }, 'past the frame it would have covered, at the height it was aimed')
})

test('dragging snaps to a neighbour within the threshold and draws its guide', () => {
  const other = { x: 1000, y: 200, width: 400, height: 300 }
  const near = snapMove({ x: 300, y: 204, width: 400, height: 300 }, [other], 1)
  assert.deepEqual(near.rect, { x: 300, y: 200, width: 400, height: 300 })
  assert.deepEqual(near.guides, [{ axis: 'y', at: 200, from: 300, to: 1400 }])
  const far = snapMove({ x: 300, y: 210, width: 400, height: 300 }, [other], 1)
  assert.deepEqual(far.guides, [])
  assert.equal(snapMove({ x: 300, y: 210, width: 400, height: 300 }, [other], 0.5).rect.y, 200, 'the threshold is in screen pixels')
})

function workspace() {
  const project = mkdtempSync(join(tmpdir(), 'ezdesign-edit-'))
  const view: ViewStore & { view: ShellView } = {
    view: {},
    setActiveTab(tab: TabId) {
      this.view = { ...this.view, activeTab: tab }
    },
    setCamera() {},
    forgetCamera() {},
  }
  const ws = openCanvasWorkspace({
    project,
    view,
    frameOrigin: () => 'http://localhost:5000',
    overlay: () => ({ assets: '1', shellOrigin: 'http://127.0.0.1:5000' }),
    hasApp: () => true,
    onChange: () => {},
  })
  ws.start()
  return { project, ws }
}

const ok = <T>(o: { ok: true; value: T } | { ok: false; problem: unknown }): T => {
  if (!o.ok) throw new Error(JSON.stringify(o.problem))
  return o.value
}

test('CV-p6-op-idempotent: a replayed step and a repeated paste change nothing', () => {
  const { project, ws } = workspace()
  const canvas = ok(ws.agent.create('c'))
  const f1 = ok(ws.agent.addFrame({ canvasId: canvas.id, title: 'one', html: '<!doctype html><html></html>' }))
  const layout = () => readFileSync(join(project, '.ezdesign', 'canvases', canvas.id, 'layout.json'), 'utf8')
  const move = (opId: string, x: number, y: number) =>
    ok(ws.user.applyLayoutOps(canvas.id, { opId: opId as OpId, ops: [{ t: 'move', frames: [{ id: f1.id, x, y }] }] }))
  move('o1', 10, 20)
  move('o2', 30, 40)
  const afterO2 = layout()
  const replay = move('o1', 10, 20)
  assert.deepEqual(replay.frames[0]!.rect, { x: 30, y: 40, width: 1280, height: 800 })
  assert.equal(layout(), afterO2)
  const copy = id(0xf9)
  const paste = { from: canvas.id, frames: [{ from: f1.id, id: copy, at: { x: 2000, y: 0 } }] }
  ok(ws.user.paste(canvas.id, paste))
  const twice = ok(ws.user.paste(canvas.id, paste))
  assert.equal(twice.frames.filter((f) => f.id === copy).length, 1)
  assert.deepEqual(readdirSync(join(project, '.ezdesign', 'canvases', canvas.id, 'frames')).sort(), [`${copy}.html`, `${f1.id}.html`].sort())
  assert.equal(twice.frames.find((f) => f.id === copy)!.title, 'one 副本')
  const gone = ok(ws.user.applyLayoutOps(canvas.id, { opId: 'o3' as OpId, ops: [{ t: 'remove', ids: [copy] }] }))
  assert.equal(gone.frames.length, 1)
  const back = ok(ws.user.applyLayoutOps(canvas.id, { opId: 'o4' as OpId, ops: [{ t: 'restore', ids: [copy] }, { t: 'move', frames: [{ id: id(0xdead), x: 0, y: 0 }] }] }))
  assert.equal(back.frames.length, 2, 'restore brings it back, and a step naming a gone frame skips it')
})

test('a page keeps the size it was added at: a move carries none, and a resize naming it is skipped', () => {
  const { ws } = workspace()
  const canvas = ok(ws.agent.create('c'))
  const phone = ok(ws.agent.addFrame({ canvasId: canvas.id, title: 'phone', html: '<!doctype html><html></html>', size: { width: 390, height: 844 } }))
  assert.equal(phone.kind, 'page')
  assert.equal(parseLayoutStep({ opId: 'o1', ops: [{ t: 'place', frames: [{ id: phone.id, rect: { x: 0, y: 0, width: 999, height: 999 } }] }] }), null)
  const step = parseLayoutStep({ opId: 'o1', ops: [{ t: 'move', frames: [{ id: phone.id, x: 50, y: 60, width: 999, height: 999 }] }] })
  assert.deepEqual(step?.ops, [{ t: 'move', frames: [{ id: phone.id, x: 50, y: 60 }] }])
  const moved = ok(ws.user.applyLayoutOps(canvas.id, step!))
  assert.deepEqual(moved.frames[0]!.rect, { x: 50, y: 60, width: 390, height: 844 })
  const resized = ok(ws.user.applyLayoutOps(canvas.id, { opId: 'o2' as OpId, ops: [{ t: 'resize', frames: [{ id: phone.id, x: 0, y: 0, width: 999, height: 999 }] }] }))
  assert.deepEqual(resized.frames[0]!.rect, { x: 50, y: 60, width: 390, height: 844 })
  const copy = ok(ws.user.paste(canvas.id, { from: canvas.id, frames: [{ from: phone.id, id: id(0xc0), at: { x: 1000, y: 0 } }] }))
  assert.deepEqual(copy.frames.find((f) => f.id === id(0xc0))!.rect, { x: 1000, y: 0, width: 390, height: 844 })
})

test('an image frame resizes, down below a page\'s minimum, and is known as one after a restart', () => {
  const { project, ws } = workspace()
  const canvas = ok(ws.agent.create('c'))
  const asset = ok(ws.user.addAsset(canvas.id, 'image/png', Buffer.from('89504e470d0a1a0a', 'hex')))
  const shot = id(0x51)
  const added = ok(ws.user.addImageFrame(canvas.id, { id: shot, asset, title: 'shot', rect: { x: 0, y: 0, width: 64, height: 32 } }))
  assert.deepEqual(added.frames[0]!.rect, { x: 0, y: 0, width: 64, height: 32 }, 'no letterbox up to a page minimum')
  assert.equal(added.frames[0]!.kind, 'image')
  const step = parseLayoutStep({ opId: 'r1', ops: [{ t: 'resize', frames: [{ id: shot, x: 10.4, y: -5, width: 20, height: 4 }] }] })
  assert.deepEqual(step?.ops, [{ t: 'resize', frames: [{ id: shot, x: 10.4, y: -5, width: 20, height: 4 }] }])
  const small = ok(ws.user.applyLayoutOps(canvas.id, step!))
  assert.deepEqual(small.frames[0]!.rect, { x: 10, y: -5, width: 20, height: 16 })
  ok(ws.user.applyLayoutOps(canvas.id, { opId: 'm1' as OpId, ops: [{ t: 'move', frames: [{ id: shot, x: 100, y: 100 }] }] }))

  ws.close()
  const reopened = openCanvasWorkspace({
    project,
    view: { view: {}, setActiveTab() {}, setCamera() {}, forgetCamera() {} },
    frameOrigin: () => 'http://localhost:5000',
    overlay: () => ({ assets: '1', shellOrigin: 'http://127.0.0.1:5000' }),
    hasApp: () => true,
    onChange: () => {},
  })
  reopened.start()
  const again = reopened.read.wire(canvas.id)!
  assert.deepEqual(again.frames[0]!.rect, { x: 100, y: 100, width: 20, height: 16 }, 'a move keeps a size under the page minimum')
  assert.equal(again.frames[0]!.kind, 'image', 'read off the document, not a record')
  reopened.close()
})

test('a resize is one step whose undo is the rect it had, shown at once while in flight', () => {
  const image = frame(1, { x: 0, y: 0, width: 400, height: 300 }, 'image')
  const page = frame(2, { x: 500, y: 0, width: 400, height: 300 })
  const step = planResize(image, { x: 0, y: 0, width: 200, height: 150 })
  assert.equal(step.label, '調整圖片大小')
  assert.deepEqual(step.apply, [{ t: 'ops', ops: [{ t: 'resize', frames: [{ id: image.id, x: 0, y: 0, width: 200, height: 150 }] }] }])
  assert.deepEqual(step.undo, [{ t: 'resize', frames: [{ id: image.id, x: 0, y: 0, width: 400, height: 300 }] }])
  assert.deepEqual(step.redo, step.apply[0]!.t === 'ops' ? step.apply[0]!.ops : null)
  const shown = withPending(canvasOf([image, page]), [
    ...step.apply,
    { t: 'ops', ops: [{ t: 'resize', frames: [{ id: page.id, x: 0, y: 0, width: 1, height: 1 }] }] },
  ])
  assert.deepEqual(shown.map((f) => f.rect), [{ x: 0, y: 0, width: 200, height: 150 }, page.rect])
})

test('pasted images land as one row centred on the view, undone and redone as one step', () => {
  let n = 0xa0
  const step = planImages(
    [
      { asset: 'aaaaaaaaaaaa.png' as AssetName, title: 'image', size: { width: 400, height: 300 } },
      { asset: 'bbbbbbbbbbbb.jpg' as AssetName, title: 'photo', size: { width: 240, height: 600 } },
    ],
    { x: 1000, y: 500 },
    () => id(n++),
  )
  assert.equal(step.label, '貼上 2 張圖片')
  assert.deepEqual(step.added, [id(0xa0), id(0xa1)])
  assert.deepEqual(step.apply, [
    { t: 'image', input: { id: id(0xa0), asset: 'aaaaaaaaaaaa.png', title: 'image', rect: { x: 640, y: 350, width: 400, height: 300 } } },
    { t: 'image', input: { id: id(0xa1), asset: 'bbbbbbbbbbbb.jpg', title: 'photo', rect: { x: 1120, y: 200, width: 240, height: 600 } } },
  ])
  assert.deepEqual(step.undo, [{ t: 'remove', ids: [id(0xa0), id(0xa1)] }])
  assert.deepEqual(step.redo, [{ t: 'restore', ids: [id(0xa0), id(0xa1)] }])
  const one = planImages([{ asset: 'aaaaaaaaaaaa.png' as AssetName, title: 'image', size: { width: 401, height: 301 } }], { x: 0, y: 0 }, () => id(1))
  assert.equal(one.label, '貼上圖片')
  assert.deepEqual((one.apply[0] as { input: { rect: Rect } }).input.rect, { x: -200, y: -150, width: 401, height: 301 })
  const existing = frame(1, { x: 0, y: 0, width: 100, height: 100 })
  assert.deepEqual(withPending(canvasOf([existing]), step.apply), [existing], 'nothing to show until the daemon writes it')
})

test('a paste onto another canvas clones the documents and the images they show, keeping their titles', () => {
  const { project, ws } = workspace()
  const dirOf = (c: CanvasId) => join(project, '.ezdesign', 'canvases', c)
  const source = ok(ws.agent.create('source'))
  const asset = ok(ws.user.addAsset(source.id, 'image/png', Buffer.from('89504e470d0a1a0a', 'hex')))
  const shot = ok(ws.user.addImageFrame(source.id, { id: id(0x51), asset, title: 'shot', rect: { x: 0, y: 0, width: 64, height: 32 } }))
  const page = ok(ws.agent.addFrame({ canvasId: source.id, title: 'hero', html: '<!doctype html><html><body>hero</body></html>' }))
  const target = ok(ws.agent.create('target'))

  const pasted = ok(
    ws.user.paste(target.id, {
      from: source.id,
      frames: [
        { from: id(0x51), id: id(0xa1), at: { x: 10, y: 20 } },
        { from: page.id, id: id(0xa2), at: { x: 300, y: 20 } },
      ],
    }),
  )
  assert.deepEqual(pasted.frames.map((f) => [f.id, f.title, f.kind, f.rect]), [
    [id(0xa1), 'shot', 'image', { x: 10, y: 20, width: 64, height: 32 }],
    [id(0xa2), 'hero', 'page', { x: 300, y: 20, width: page.rect.width, height: page.rect.height }],
  ])
  assert.ok(existsSync(join(dirOf(target.id), 'frames', 'assets', asset)), 'the image went with the frame showing it')
  assert.equal(readFileSync(join(dirOf(target.id), 'frames', `${id(0xa2)}.html`), 'utf8'), '<!doctype html><html><body>hero</body></html>')
  writeFileSync(join(dirOf(source.id), 'frames', `${page.id}.html`), '<!doctype html><html><body>changed</body></html>')
  assert.match(readFileSync(join(dirOf(target.id), 'frames', `${id(0xa2)}.html`), 'utf8'), /hero/, 'a copy, not a link: editing the source leaves it')
  assert.equal(ok(ws.user.paste(target.id, { from: source.id, frames: [{ from: shot.frames[0]!.id, id: id(0xa3), at: { x: 0, y: 900 } }] })).frames.length, 3)
  assert.deepEqual(readdirSync(join(dirOf(target.id), 'frames', 'assets')), [asset], 'an image already there is not copied twice')
})

test('a paste is all or none, reaches a frame removed this week, and only a canvas of this project', () => {
  const { project, ws } = workspace()
  const canvas = ok(ws.agent.create('c'))
  const f1 = ok(ws.agent.addFrame({ canvasId: canvas.id, title: 'one', html: '<!doctype html><html></html>' }))
  const other = ok(ws.agent.create('other'))

  const missing = ws.user.paste(other.id, {
    from: canvas.id,
    frames: [
      { from: f1.id, id: id(0xb1), at: { x: 0, y: 0 } },
      { from: id(0xdead), id: id(0xb2), at: { x: 0, y: 0 } },
    ],
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.ok === false && missing.problem.code, 'FRAME_NOT_FOUND')
  assert.deepEqual(readdirSync(join(project, '.ezdesign', 'canvases', other.id, 'frames')), [], 'nothing written for half a paste')

  ok(ws.user.applyLayoutOps(canvas.id, { opId: 'cut' as OpId, ops: [{ t: 'remove', ids: [f1.id] }] }))
  const cut = ok(ws.user.paste(other.id, { from: canvas.id, frames: [{ from: f1.id, id: id(0xb3), at: { x: 0, y: 0 } }] }))
  assert.deepEqual(cut.frames.map((f) => f.title), ['one'], 'a cut source is still there to paste')

  const elsewhere = ws.user.paste(other.id, { from: 'ffffffffffff' as CanvasId, frames: [{ from: f1.id, id: id(0xb4), at: { x: 0, y: 0 } }] })
  assert.equal(elsewhere.ok === false && elsewhere.problem.code, 'CANVAS_NOT_FOUND')
})

test('a paste request names canvas, frames and points, and nothing twice', () => {
  const at = { x: 1, y: 2 }
  assert.deepEqual(parsePaste({ from: 'aaaaaaaaaaaa', frames: [{ from: id(1), id: id(2), at, html: '<b>' }] }), {
    from: 'aaaaaaaaaaaa',
    frames: [{ from: id(1), id: id(2), at }],
  })
  assert.equal(parsePaste({ from: 'aaaaaaaaaaaa', frames: [] }), null)
  assert.equal(parsePaste({ from: 'aaaaaaaaaaaa', frames: [{ from: id(1), id: id(2), at }, { from: id(3), id: id(2), at }] }), null)
  assert.equal(parsePaste({ from: '../etc', frames: [{ from: id(1), id: id(2), at }] }), null)
  assert.equal(parsePaste({ from: 'aaaaaaaaaaaa', frames: [{ from: id(1), id: id(2) }] }), null)
})
