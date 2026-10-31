/** The board's edits as data: what a gesture becomes on the wire, what undoes
 *  and redoes it, and what the board shows while the daemon has not answered.
 *  Pure, like `pick.ts` and `nav.ts`, so undo across an agent's concurrent
 *  change is testable without a DOM.
 *
 *  - A gesture (drag, duplicate, delete, a nudge run) is one `EditStep`.
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

import { GAP, placeBeside } from '../../canvas/place.js'
import type { AssetName, FrameId, Point, Size } from '../../canvas/types.js'
import type { CanvasWire, DuplicateWire, FrameWire, ImageFrameWire, LayoutOp } from '../../canvas/wire.js'

/** What one request asks the daemon for. */
export type BoardEdit =
  | { t: 'ops'; ops: LayoutOp[] }
  | { t: 'duplicate'; input: DuplicateWire }
  | { t: 'image'; input: ImageFrameWire }

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

const move = (frames: ({ id: FrameId } & Point)[]): LayoutOp => ({ t: 'move', frames })

/** Group move: one `move` for every selected frame. */
export function planMove(
  frames: readonly FrameWire[],
  ids: ReadonlySet<FrameId>,
  dx: number,
  dy: number,
  opts: { nudge?: boolean } = {},
): EditStep {
  const moving = frames.filter((f) => ids.has(f.id))
  const to = move(moving.map((f) => ({ id: f.id, x: f.rect.x + dx, y: f.rect.y + dy })))
  const from = move(moving.map((f) => ({ id: f.id, x: f.rect.x, y: f.rect.y })))
  return {
    label: moving.length > 1 ? `移動 ${moving.length} 個 frame` : '移動 frame',
    apply: [{ t: 'ops', ops: [to] }],
    undo: [from],
    redo: [to],
    ...(opts.nudge ? { nudge: true as const } : {}),
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
    rects.push({ ...at, width: source.rect.width, height: source.rect.height })
    const id = mint()
    copies.push(id)
    apply.push({ t: 'duplicate', input: { from: source.id, id, at } })
  }
  return {
    label: copies.length > 1 ? `複製 ${copies.length} 個 frame` : '複製 frame',
    apply,
    undo: [{ t: 'remove', ids: copies }],
    redo: [{ t: 'restore', ids: copies }],
    copies,
  }
}

/** Pasted images, already stored, as one step: a row with `GAP` between them,
 *  centred on `center` (the middle of the view), as a paste lands in Figma. */
export function planImages(
  images: readonly { asset: AssetName; title: string; size: Size }[],
  center: Point,
  mint: () => FrameId,
): EditStep & { added: FrameId[] } {
  const width = images.reduce((sum, image) => sum + image.size.width, 0) + GAP * (images.length - 1)
  let x = Math.round(center.x - width / 2)
  const inputs = images.map((image): ImageFrameWire => {
    const rect = { x, y: Math.round(center.y - image.size.height / 2), ...image.size }
    x += image.size.width + GAP
    return { id: mint(), asset: image.asset, title: image.title, rect }
  })
  const added = inputs.map((input) => input.id)
  return {
    label: added.length > 1 ? `貼上 ${added.length} 張圖片` : '貼上圖片',
    apply: inputs.map((input) => ({ t: 'image', input })),
    undo: [{ t: 'remove', ids: added }],
    redo: [{ t: 'restore', ids: added }],
    added,
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
      frames.push({ ...source, id: edit.input.id, rect: { ...source.rect, ...edit.input.at } })
      continue
    }
    // No document to show until the daemon has written one.
    if (edit.t === 'image') continue
    for (const op of edit.ops) {
      if (op.t === 'move') {
        const at = new Map(op.frames.map((f) => [f.id, f]))
        frames = frames.map((f) => {
          const to = at.get(f.id)
          return to ? { ...f, rect: { ...f.rect, x: to.x, y: to.y } } : f
        })
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
