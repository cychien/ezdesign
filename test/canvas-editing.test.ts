import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CanvasId, FrameId, Rect, ShellView, TabId, ViewStore } from '../src/canvas/types.js'
import type { CanvasWire, FrameWire, LayoutOp, OpId } from '../src/canvas/wire.js'
import { openCanvasWorkspace } from '../src/canvas/workspace.js'
import { snapMove, snapResize } from '../src/client/canvas/guides.js'
import {
  EditHistory,
  HISTORY_LIMIT,
  NUDGE_FOLD_MS,
  planDuplicate,
  planMove,
  planRemove,
  planResize,
  withPending,
} from '../src/client/canvas/history.js'

const id = (n: number) => n.toString(16).padStart(12, '0') as FrameId
const frame = (n: number, rect: Rect): FrameWire => ({ id: id(n), title: `f${n}`, rect, file: `f${n}.html`, hash: `h${n}`, src: `src${n}` })
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
  run(planResize(frames.find((f) => f.id === id(2))!, { x: 500, y: 0, width: 600, height: 700 }), 1000)
  run(planMove(frames, new Set([id(1), id(2), id(3)]), -10, 20), 2000)
  run(planRemove(new Set([id(3)])), 3000)
  const end = frames.map((f) => [f.id, f.rect])
  assert.deepEqual(end, [
    [id(1), { x: 90, y: 70, width: 400, height: 300 }],
    [id(2), { x: 490, y: 20, width: 600, height: 700 }],
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
  assert.deepEqual(history.undo(), [{ t: 'place', frames: [{ id: id(1), rect: { x: 0, y: 0, width: 400, height: 300 } }] }])
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
  const step = planDuplicate(frames, new Set([id(1), id(2)]), () => id(n++))
  assert.deepEqual(step.copies, [id(100), id(101)])
  const shown = withPending(canvasOf(frames), step.apply)
  assert.deepEqual(shown.map((f) => [f.id, f.rect.x, f.rect.y, f.src]), [
    [id(1), 0, 0, 'src1'],
    [id(2), 0, 1000, 'src2'],
    [id(100), 480, 0, 'src1'],
    [id(101), 480, 1000, 'src2'],
  ])
  assert.deepEqual(step.undo, [{ t: 'remove', ids: [id(100), id(101)] }])
})

test('dragging snaps to a neighbour within the threshold and draws its guide', () => {
  const other = { x: 1000, y: 200, width: 400, height: 300 }
  const near = snapMove({ x: 300, y: 204, width: 400, height: 300 }, [other], 1)
  assert.deepEqual(near.rect, { x: 300, y: 200, width: 400, height: 300 })
  assert.deepEqual(near.guides, [{ axis: 'y', at: 200, from: 300, to: 1400 }])
  const far = snapMove({ x: 300, y: 210, width: 400, height: 300 }, [other], 1)
  assert.deepEqual(far.guides, [])
  assert.equal(snapMove({ x: 300, y: 210, width: 400, height: 300 }, [other], 0.5).rect.y, 200, 'the threshold is in screen pixels')
  const resized = snapResize({ x: 0, y: 0, width: 997, height: 300 }, 'e', [other], 1, { width: 240, height: 240 })
  assert.deepEqual(resized.rect, { x: 0, y: 0, width: 1000, height: 300 })
  const small = snapResize({ x: 0, y: 0, width: 100, height: 300 }, 'e', [], 1, { width: 240, height: 240 })
  assert.equal(small.rect.width, 240)
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
    overlay: () => ({ version: '1', shellOrigin: 'http://127.0.0.1:5000' }),
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

test('CV-p6-op-idempotent: a replayed step and a repeated duplicate change nothing', () => {
  const { project, ws } = workspace()
  const canvas = ok(ws.agent.create('c'))
  const f1 = ok(ws.agent.addFrame({ canvasId: canvas.id, title: 'one', html: '<!doctype html><html></html>' }))
  const layout = () => readFileSync(join(project, '.ezdesign', 'canvases', canvas.id, 'layout.json'), 'utf8')
  const move = (opId: string, x: number, y: number) =>
    ok(ws.user.applyLayoutOps(canvas.id, { opId: opId as OpId, ops: [{ t: 'place', frames: [{ id: f1.id, rect: { x, y, width: 400, height: 300 } }] }] }))
  move('o1', 10, 20)
  move('o2', 30, 40)
  const afterO2 = layout()
  const replay = move('o1', 10, 20)
  assert.deepEqual(replay.frames[0]!.rect, { x: 30, y: 40, width: 400, height: 300 })
  assert.equal(layout(), afterO2)
  const copy = id(0xf9)
  ok(ws.user.duplicate(canvas.id, { from: f1.id, id: copy }))
  const twice = ok(ws.user.duplicate(canvas.id, { from: f1.id, id: copy }))
  assert.equal(twice.frames.filter((f) => f.id === copy).length, 1)
  assert.deepEqual(readdirSync(join(project, '.ezdesign', 'canvases', canvas.id, 'frames')).sort(), [`${copy}.html`, `${f1.id}.html`].sort())
  assert.equal(twice.frames.find((f) => f.id === copy)!.title, 'one 副本')
  const gone = ok(ws.user.applyLayoutOps(canvas.id, { opId: 'o3' as OpId, ops: [{ t: 'remove', ids: [copy] }] }))
  assert.equal(gone.frames.length, 1)
  const back = ok(ws.user.applyLayoutOps(canvas.id, { opId: 'o4' as OpId, ops: [{ t: 'restore', ids: [copy] }, { t: 'place', frames: [{ id: id(0xdead), rect: { x: 0, y: 0, width: 1, height: 1 } }] }] }))
  assert.equal(back.frames.length, 2, 'restore brings it back, and a step naming a gone frame skips it')
})
