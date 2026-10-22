/** The canvas domain: what a canvas is, independent of how it is stored,
 *  served, drawn or handed to the agent. Node-free, because the shell bundle
 *  imports these types too.
 *
 *  A canvas is an infinite board of *frames*, and a frame is one complete HTML
 *  document in its own iframe at a real viewport width. (The multi-device
 *  preview is the device *grid*, not a canvas.)
 *
 *  Ownership is written as capability interfaces in `workspace.ts`: the agent's
 *  side writes documents and titles, the user's side writes geometry,
 *  membership and the view. */

declare const canvasIdBrand: unique symbol
declare const frameIdBrand: unique symbol

export type CanvasId = string & { readonly [canvasIdBrand]: true }
export type FrameId = string & { readonly [frameIdBrand]: true }

/** Twelve lowercase hex digits, `newId()`'s shape. Refusing anything else at the
 *  boundary is what keeps an id that reaches a path from being `..`. */
const ID_SHAPE = /^[0-9a-f]{12}$/

export function asCanvasId(raw: unknown): CanvasId | null {
  return typeof raw === 'string' && ID_SHAPE.test(raw) ? (raw as CanvasId) : null
}

export function asFrameId(raw: unknown): FrameId | null {
  return typeof raw === 'string' && ID_SHAPE.test(raw) ? (raw as FrameId) : null
}

/** A frame id minted in the browser for a frame the user makes (duplicate), so
 *  the request that creates it is idempotent: a retry names the same frame. */
export function mintFrameId(random: (bytes: Uint8Array) => Uint8Array): FrameId {
  const bytes = random(new Uint8Array(6))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') as FrameId
}

/** The App tab, or one canvas. A canvas id is hex, so it never reads as `app`. */
export type TabId = 'app' | CanvasId

export function asTabId(raw: unknown): TabId | null {
  return raw === 'app' ? 'app' : asCanvasId(raw)
}

/** World coordinates: CSS pixels of the frame's own viewport at zoom 1.
 *  Integers on disk (see `normalizeRect`). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** `screen = (world - (x, y)) * zoom`, relative to the board's top-left. */
export interface Camera {
  x: number
  y: number
  zoom: number
}

export const ZOOM_MIN = 0.05
export const ZOOM_MAX = 4

/** Project-relative, posix. ezdesign never edits the project's `.gitignore`:
 *  committing canvases is the user's call. */
export const CANVASES_DIR = '.ezdesign/canvases'

/** A whole page with inline assets: generous, still a cap, because the body is
 *  JSON-escaped on the way in and the file may be committed. */
export const MAX_FRAME_HTML = 512 * 1024
export const MAX_FRAMES_PER_CANVAS = 200
export const MAX_CANVAS_NAME = 60
export const MAX_FRAME_TITLE = 80
export const DEFAULT_FRAME_WIDTH = 1280
export const MIN_FRAME_SIZE: Size = { width: 240, height: 240 }
export const MAX_FRAME_SIZE: Size = { width: 3840, height: 12000 }

/** One live frame as every reader sees it: the manifest entry joined with its
 *  rect from the layout. Deleted frames are not in this projection at all, so
 *  no reader can forget to filter them. */
export interface CanvasFrame {
  id: FrameId
  title: string
  /** Project-relative path of the document: `.ezdesign/canvases/<c>/frames/<f>.html`.
   *  The `file` in its anchors' `file:line`, and what the agent edits. */
  file: string
  /** sha1 of the file's bytes as the daemon last read or wrote them. The
   *  agent's `expectedHash`, the iframe url's `rev`. */
  hash: string
  rect: Rect
  createdAt: number
}

export interface Canvas {
  id: CanvasId
  name: string
  createdAt: number
  /** Set while closed: no tab, files kept, changes refused until reopened. */
  archivedAt?: number
  /** Live frames, bottom to top. */
  frames: CanvasFrame[]
}

/** One canvas as the tab strip, the 所有 canvas menu, the agent's list and the
 *  per-turn brief all need it: counts, never frames. */
export interface CanvasSummary {
  id: CanvasId
  name: string
  archived: boolean
  frames: number
  /** Tab order. There is no stored tab list: open tabs are "not archived". */
  createdAt: number
}

export interface CanvasInventory {
  activeTab: TabId | null
  /** Every canvas, archived included, oldest first. */
  canvases: CanvasSummary[]
}

/** Where the viewer is: not project content, so it lives in the session's data
 *  dir (`view.json`), never in `.ezdesign/` where it would be committed. */
export interface ShellView {
  activeTab?: TabId
  cameras?: Partial<Record<CanvasId, Camera>>
}

/** What the canvas workspace needs of the session to keep the view. Implemented
 *  by `SessionStore`. */
export interface ViewStore {
  readonly view: ShellView
  setActiveTab(tab: TabId): void
  setCamera(canvasId: CanvasId, camera: Camera): void
  forgetCamera(canvasId: CanvasId): void
}

/** Every reason a canvas operation is refused, for every caller. The agent's
 *  words come from `canvasProblemMessage` (mcp.ts) and the HTTP status from
 *  `statusOf` (routes.ts), each a switch the compiler holds exhaustive. Nothing
 *  is written when one is returned. */
export type CanvasProblem =
  | { code: 'CANVAS_NOT_FOUND'; canvasId: string; known: { id: CanvasId; name: string }[] }
  | { code: 'CANVAS_ARCHIVED'; canvasId: CanvasId; name: string }
  | { code: 'FRAME_NOT_FOUND'; canvasId: CanvasId; frameId: string }
  /** `update_frame` named an `expectedHash` the file no longer has: someone (an
   *  editor, the agent's own file tools) changed it since it was read. */
  | { code: 'FRAME_CONFLICT'; canvasId: CanvasId; frameId: FrameId; currentHash: string }
  | { code: 'HTML_EMPTY' }
  | { code: 'HTML_TOO_LARGE'; bytes: number; limit: number }
  /** A fragment, not a page: no `<!doctype html>` or `<html>` up front. */
  | { code: 'NOT_A_DOCUMENT' }
  | { code: 'TOO_MANY_FRAMES'; limit: number }
  | { code: 'BAD_NAME'; max: number }
  | { code: 'BAD_RECT'; reason: string }

export type Outcome<T> = { ok: true; value: T } | { ok: false; problem: CanvasProblem }
