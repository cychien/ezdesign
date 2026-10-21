/** Board geometry both sides need: where a frame with no position goes and what
 *  a legal rect is. Pure and node-free - the daemon places the agent's frames,
 *  the shell will place the user's duplicates, and they must place the same way. */

import { MAX_FRAME_SIZE, MIN_FRAME_SIZE, type Point, type Rect, type Size } from './types.js'

/** Clear space kept between frames placed for the user, so a frame's title is
 *  always there to read and grab. */
export const GAP = 80
/** A row of auto-placed frames wraps past this width, so forty frames read as a
 *  grid rather than a ribbon nobody can fit on screen. */
export const ROW_LIMIT = 8000

/** Overlap with `gap` folded in: frames closer than `gap` count as overlapping. */
export function overlaps(a: Rect, b: Rect, gap = GAP): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
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

/** Where a frame added without a position goes: never overlapping a live frame.
 *  `existing` is bottom-to-top, so its last entry is the most recent: an agent
 *  adding a series is laying out a row, which the first choice continues. Total
 *  and deterministic; O(n) per candidate, three candidates. */
export function autoPlace(existing: readonly Rect[], size: Size): Point {
  const bounds = boundsOf(existing)
  const last = existing[existing.length - 1]
  if (!bounds || !last) return { x: 0, y: 0 }
  const fits = (at: Point) => {
    const rect = { ...at, ...size }
    return at.x + size.width <= bounds.x + ROW_LIMIT && !existing.some((r) => overlaps(rect, r))
  }
  const beside = { x: last.x + last.width + GAP, y: last.y }
  if (fits(beside)) return beside
  const right = { x: bounds.x + bounds.width + GAP, y: bounds.y }
  if (right.x + size.width <= bounds.x + ROW_LIMIT) return right
  return { x: bounds.x, y: bounds.y + bounds.height + GAP }
}
