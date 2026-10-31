/** Board geometry both sides need: where a frame with no position goes and what
 *  a legal rect is. Pure and node-free - the daemon places the agent's frames,
 *  the shell will place the user's duplicates, and they must place the same way. */

import { MAX_FRAME_SIZE, MIN_FRAME_SIZE, type Point, type Rect, type Size } from './types.js'

/** Clear space kept beside frames placed for the user. */
export const GAP = 80
/** Clear space kept above and below them: a frame's title sits in it at a
 *  constant screen size, so it takes more of the gap the further out the board
 *  is zoomed. This clears the title down to about 10%. */
export const ROW_GAP = 240
/** A row of auto-placed frames wraps past this width, so forty frames read as a
 *  grid rather than a ribbon nobody can fit on screen. */
export const ROW_LIMIT = 8000

/** Overlap with the gaps folded in: frames closer than `GAP` side by side or
 *  `ROW_GAP` one above the other count as overlapping. */
export function overlaps(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width + GAP <= b.x ||
    b.x + b.width + GAP <= a.x ||
    a.y + a.height + ROW_GAP <= b.y ||
    b.y + b.height + ROW_GAP <= a.y
  )
}

/** The smallest rect holding all of `rects`; null for none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

/** A common screen for the width class: a 390 is a phone, a 1280 a laptop. */
export function defaultHeightFor(width: number): number {
  if (width <= 480) return 844
  if (width <= 1024) return 1024
  return 800
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Whole numbers inside `MIN_FRAME_SIZE..MAX_FRAME_SIZE`, so a value from the
 *  wire cannot write 412.0000001 or a kilometre-wide frame into the repo. */
export function normalizeRect(raw: Rect): Rect {
  return {
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: clamp(Math.round(raw.width), MIN_FRAME_SIZE.width, MAX_FRAME_SIZE.width),
    height: clamp(Math.round(raw.height), MIN_FRAME_SIZE.height, MAX_FRAME_SIZE.height),
  }
}

/** A frame's new height, and the frames that move down to make room for it: every
 *  frame below its old bottom whose span overlaps it, then every frame below
 *  those whose span overlaps one of them, each by the growth, so the gaps
 *  between them hold. A frame that shrinks moves nothing. */
export function growDown<K>(
  rect: Rect,
  height: number,
  others: readonly (readonly [K, Rect])[],
): { rect: Rect; moved: [K, Rect][] } {
  const next = normalizeRect({ ...rect, height })
  const growth = next.height - rect.height
  if (growth <= 0) return { rect: next, moved: [] }
  const spanned = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width
  const pushers: Rect[] = [rect]
  const moved: [K, Rect][] = []
  const below = others.filter(([, r]) => r.y >= rect.y + rect.height).sort((a, b) => a[1].y - b[1].y)
  for (const [id, r] of below) {
    if (!pushers.some((p) => spanned(p, r))) continue
    pushers.push(r)
    moved.push([id, { ...r, y: r.y + growth }])
  }
  return { rect: next, moved }
}

/** A pasted image's frame: its natural size, scaled down to fit
 *  `MAX_FRAME_SIZE` with its aspect kept, and never under `MIN_FRAME_SIZE`
 *  (the document letterboxes a small image). */
export function imageFrameSize(natural: Size): Size {
  const scale = Math.min(1, MAX_FRAME_SIZE.width / natural.width, MAX_FRAME_SIZE.height / natural.height)
  return {
    width: Math.max(MIN_FRAME_SIZE.width, Math.round(natural.width * scale)),
    height: Math.max(MIN_FRAME_SIZE.height, Math.round(natural.height * scale)),
  }
}

/** The first spot at or right of `from`, on its row, that overlaps nothing:
 *  past every frame in the way, never past `limit`. Null when the row is full. */
function freeAlongRow(from: Point, size: Size, existing: readonly Rect[], limit: number): Point | null {
  let x = from.x
  for (;;) {
    if (x + size.width > limit) return null
    const rect = { x, y: from.y, width: size.width, height: size.height }
    const hits = existing.filter((r) => overlaps(rect, r))
    if (!hits.length) return { x, y: from.y }
    x = Math.max(...hits.map((r) => r.x + r.width + GAP))
  }
}

/** Where a frame added without a position goes: never overlapping a live frame.
 *  `turn` is what the agent's current turn has already added here, in order: a
 *  turn's frames read left to right, and each turn starts a row of its own
 *  under everything before it. Total and deterministic. */
export function autoPlace(existing: readonly Rect[], turn: readonly Rect[], size: Size): Point {
  const bounds = boundsOf(existing)
  if (!bounds) return { x: 0, y: 0 }
  const last = turn[turn.length - 1]
  const next = last && freeAlongRow({ x: last.x + last.width + GAP, y: last.y }, size, existing, bounds.x + ROW_LIMIT)
  return next ?? { x: bounds.x, y: bounds.y + bounds.height + ROW_GAP }
}

/** The user's duplicate: on its source's row, at the first free spot right of it. */
export function placeBeside(source: Rect, existing: readonly Rect[]): Point {
  return freeAlongRow({ x: source.x + source.width + GAP, y: source.y }, source, existing, Infinity)!
}
