/** What crosses the wire between the daemon and the review shell about
 *  canvases. Node-free: the shell bundle imports these, and one definition for
 *  both sides is the point - the shell's older wire types are hand-copied, and
 *  these must not join them.
 *
 *  Two sizes on purpose. The snapshot carries `CanvasSnapshotWire` - summaries
 *  only - because it is re-sent whole on every streamed agent token. A whole
 *  `CanvasWire` goes only when that canvas changed, as the named SSE event
 *  `canvas` to shell clients (`/events?shell=1`), and in the first flush for
 *  every open canvas so a tab opens with no fetch. Frame HTML never travels
 *  here: each iframe loads its own document from the frame host. */

import type { Camera, CanvasId, CanvasSummary, FrameId, Rect, TabId } from './types.js'

/** Present on the snapshot only with `EZDESIGN_CANVAS=1`; a shell that sees no
 *  `canvas` field draws no tab strip and behaves as on main. */
export interface CanvasSnapshotWire {
  /** Every canvas, archived included: the 所有 canvas menu lists both. */
  canvases: CanvasSummary[]
  /** One per session: the agent creating a canvas moves every open shell.
   *  Null only before a shell has connected to a project with nothing to show. */
  activeTab: TabId | null
  /** The attached agent takes the canvas tools (ACP with HTTP MCP). Mirrors
   *  `canExplore`; a poll-mode agent cannot. */
  agentHasTools: boolean
}

export interface FrameWire {
  id: FrameId
  title: string
  rect: Rect
  /** Project-relative, for the anchor and the agent. */
  file: string
  /** The board reloads an iframe when, and only when, this changes. */
  hash: string
  /** Absolute url on the frame host, `?rev=<hash>` included. Built by the
   *  daemon; the shell never assembles one. */
  src: string
}

export interface CanvasWire {
  id: CanvasId
  name: string
  archived: boolean
  createdAt: number
  /** The session's saved camera for this canvas (`view.json`), absent for one
   *  never looked at. A board reads it once, on its first show, and ignores it
   *  after, so one window's pan never yanks another's board. */
  camera?: Camera
  /** Live frames, bottom to top: array order is paint order. */
  frames: FrameWire[]
}

/** SSE event names on `GET /__ezdesign/api/events?shell=1`. The unnamed message
 *  stays the snapshot, so every existing `onmessage` listener is unaffected. */
export const SSE_CANVAS = 'canvas'
export const SSE_CANVAS_REMOVED = 'canvas-removed'

export type CanvasEventWire =
  | { type: typeof SSE_CANVAS; canvas: CanvasWire }
  | { type: typeof SSE_CANVAS_REMOVED; canvasId: CanvasId }

/** One user edit on the board. Absolute and keyed by ids the client already
 *  knows, so applying it twice lands the same way, and an op naming a frame that
 *  is gone (the agent removed it meanwhile) is skipped rather than refused. */
export type LayoutOp =
  /** Move and/or resize; a group move is one op with several frames. */
  | { t: 'place'; frames: { id: FrameId; rect: Rect }[] }
  /** Soft: the frame leaves the board, its file stays, so undo needs no HTML. */
  | { t: 'remove'; ids: FrameId[] }
  /** Undo of a remove. */
  | { t: 'restore'; ids: FrameId[] }

declare const opIdBrand: unique symbol
/** Minted by the board per undo step. The daemon remembers the recent ones per
 *  canvas, so a request replayed after a lost answer applies nothing. */
export type OpId = string & { readonly [opIdBrand]: true }

/** `POST /canvases/:id/ops`: one undo step, all or nothing. */
export interface LayoutStepWire {
  opId: OpId
  ops: LayoutOp[]
}

/** `POST /canvases/:id/frames`: the user's duplicate. The client mints the copy's
 *  id, so a retried request creates nothing twice. The user's path never carries
 *  HTML: the copy's bytes are read from the source frame's file. */
export interface DuplicateWire {
  from: FrameId
  id: FrameId
  /** Where the user dropped it; absent means beside the source. */
  rect?: Rect
}

/** `PUT /view`. Persisted in the session's `view.json`; a camera is never
 *  broadcast (one window's pan would yank another's board), the tab is. */
export interface ViewWire {
  activeTab?: TabId
  camera?: { canvasId: CanvasId; camera: Camera }
}
