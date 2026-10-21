/** The board's edits as data: what a gesture becomes on the wire, what undoes
 *  and redoes it, and what the board shows while the daemon has not answered.
 *  Pure, like `pick.ts` and `nav.ts`, so undo across an agent's concurrent
 *  change is testable without a DOM.
 *
 *  - A gesture (drag, resize, duplicate, delete, a nudge run) is one `EditStep`.
 *    Its undo and redo are layout ops known when the step is made: removes are
 *    soft on the daemon, so undoing a delete is a `restore` that needs no HTML,
 *    and a duplicate's copy has a client-minted id, so undoing it is a `remove`
 *    of that id and redoing it a `restore`.
 *  - Ops are absolute, so the board applies a step at once, sends it, and
 *    re-applies what is still in flight over every canvas the daemon pushes
 *    (`withPending`); its own echo moves nothing.
 *  - Only the user's own steps are here. Agent changes are not undoable from the
 *    board, and an undo naming a frame the agent removed is skipped by the
 *    daemon, so the history never needs rewriting. Camera moves are not edits. */

import { placeBeside } from '../../canvas/place.js'
import type { FrameId, Rect } from '../../canvas/types.js'
import type { CanvasWire, DuplicateWire, FrameWire, LayoutOp } from '../../canvas/wire.js'

/** What one request asks the daemon for. */
export type BoardEdit = { t: 'ops'; ops: LayoutOp[] } | { t: 'duplicate'; input: DuplicateWire }

export interface EditStep {
  label: string
  /** The first application. */
  apply: BoardEdit[]
  undo: LayoutOp[]
  /** Re-application after an undo; for a duplicate, `restore` of the copy. */
  redo: LayoutOp[]
  /** Set on an arrow-key nudge, so a run of them folds into one step. */
  nudge?: true
}

export const HISTORY_LIMIT = 100
/** Consecutive nudges within this fold into one step, so holding an arrow key
 *  is one undo. */
export const NUDGE_FOLD_MS = 600

const place = (frames: { id: FrameId; rect: Rect }[]): LayoutOp => ({ t: 'place', frames })

/** Group move: one `place` for every selected frame. */
export function planMove(
  frames: readonly FrameWire[],
  ids: ReadonlySet<FrameId>,
  dx: number,
  dy: number,
  opts: { nudge?: boolean } = {},
): EditStep {
  const moving = frames.filter((f) => ids.has(f.id))
  const to = place(moving.map((f) => ({ id: f.id, rect: { ...f.rect, x: f.rect.x + dx, y: f.rect.y + dy } })))
  const from = place(moving.map((f) => ({ id: f.id, rect: f.rect })))
  return {
    label: moving.length > 1 ? `移動 ${moving.length} 個 frame` : '移動 frame',
    apply: [{ t: 'ops', ops: [to] }],
    undo: [from],
    redo: [to],
    ...(opts.nudge ? { nudge: true as const } : {}),
  }
}

export function planResize(frame: FrameWire, rect: Rect): EditStep {
  const to = place([{ id: frame.id, rect }])
  return {
    label: '調整 frame 大小',
    apply: [{ t: 'ops', ops: [to] }],
    undo: [place([{ id: frame.id, rect: frame.rect }])],
    redo: [to],
  }
}

/** One duplicate per selected frame, each placed with `placeBeside` against the
 *  frames as they will be after the earlier copies, so copies do not stack. */
export function planDuplicate(
  frames: readonly FrameWire[],
  ids: ReadonlySet<FrameId>,
  mint: () => FrameId,
): EditStep & { copies: FrameId[] } {
  const rects = frames.map((f) => f.rect)
  const apply: BoardEdit[] = []
  const copies: FrameId[] = []
  for (const source of frames.filter((f) => ids.has(f.id))) {
    const at = placeBeside(source.rect, rects)
    const rect = { ...at, width: source.rect.width, height: source.rect.height }
    rects.push(rect)
    const id = mint()
    copies.push(id)
    apply.push({ t: 'duplicate', input: { from: source.id, id, rect } })
  }
  return {
    label: copies.length > 1 ? `複製 ${copies.length} 個 frame` : '複製 frame',
    apply,
    undo: [{ t: 'remove', ids: copies }],
    redo: [{ t: 'restore', ids: copies }],
    copies,
  }
}

export function planRemove(ids: ReadonlySet<FrameId>): EditStep {
  const list = [...ids]
  return {
    label: list.length > 1 ? `刪除 ${list.length} 個 frame` : '刪除 frame',
    apply: [{ t: 'ops', ops: [{ t: 'remove', ids: list }] }],
    undo: [{ t: 'restore', ids: list }],
    redo: [{ t: 'remove', ids: list }],
  }
}

/** The frames as the board shows them: the daemon's latest canvas with the edits
 *  still in flight applied on top. A duplicate in flight shows its source's
 *  document until the daemon's copy arrives. A `restore` in flight can only show
 *  what the board still knows, so the undo of a delete appears when the daemon
 *  answers. */
export function withPending(canvas: CanvasWire, pending: readonly BoardEdit[]): FrameWire[] {
  let frames = [...canvas.frames]
  for (const edit of pending) {
    if (edit.t === 'duplicate') {
      const source = frames.find((f) => f.id === edit.input.from)
      if (!source || frames.some((f) => f.id === edit.input.id)) continue
      frames.push({ ...source, id: edit.input.id, rect: edit.input.rect ?? source.rect })
      continue
    }
    for (const op of edit.ops) {
      if (op.t === 'place') {
        const at = new Map(op.frames.map((f) => [f.id, f.rect]))
        frames = frames.map((f) => (at.has(f.id) ? { ...f, rect: at.get(f.id)! } : f))
      } else if (op.t === 'remove') {
        const gone = new Set(op.ids)
        frames = frames.filter((f) => !gone.has(f.id))
      }
    }
  }
  return frames
}

/** Undo and redo stacks for one board, for the life of the shell page. */
export class EditHistory {
  private done: EditStep[] = []
  private undone: EditStep[] = []
  private lastNudgeAt = -Infinity

  /** A new step. Clears redo; folds a nudge into the nudge before it. */
  push(step: EditStep, now: number): void {
    this.undone = []
    const last = this.done[this.done.length - 1]
    if (step.nudge && last?.nudge && now - this.lastNudgeAt <= NUDGE_FOLD_MS) {
      this.done[this.done.length - 1] = { ...last, redo: step.redo, apply: step.apply }
    } else {
      this.done.push(step)
      if (this.done.length > HISTORY_LIMIT) this.done.shift()
    }
    this.lastNudgeAt = step.nudge ? now : -Infinity
  }

  /** The ops to send for an undo, or null with nothing to undo. */
  undo(): LayoutOp[] | null {
    const step = this.done.pop()
    if (!step) return null
    this.undone.push(step)
    this.lastNudgeAt = -Infinity
    return step.undo
  }

  redo(): LayoutOp[] | null {
    const step = this.undone.pop()
    if (!step) return null
    this.done.push(step)
    this.lastNudgeAt = -Infinity
    return step.redo
  }

  get canUndo(): boolean {
    return this.done.length > 0
  }

  get canRedo(): boolean {
    return this.undone.length > 0
  }
}
