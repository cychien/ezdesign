/** Alignment guides and snapping while a frame is dragged or resized. Pure, so
 *  the threshold and the "nearest wins" rule are tested once.
 *
 *  Candidates are the left, centre and right x of every other live frame and
 *  the top, middle and bottom y; a moving edge or centre within `SNAP_PX`
 *  screen pixels of one snaps to it and a guide line is drawn through it. */

import type { Rect } from '../../canvas/types.js'

export const SNAP_PX = 6

export interface Guide {
  axis: 'x' | 'y'
  /** World coordinate of the line. */
  at: number
  /** World extent the line is drawn over: from the moving frame to the frame
   *  it aligned with. */
  from: number
  to: number
}

export interface SnapResult {
  rect: Rect
  guides: Guide[]
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const xs = (r: Rect) => [r.x, r.x + r.width / 2, r.x + r.width]
const ys = (r: Rect) => [r.y, r.y + r.height / 2, r.y + r.height]

interface Match {
  delta: number
  at: number
  other: Rect
}

/** The nearest candidate to any of `points` within `threshold`, if one is. */
function nearest(points: number[], others: readonly Rect[], of: (r: Rect) => number[], threshold: number): Match | null {
  let best: Match | null = null
  for (const other of others) {
    for (const at of of(other)) {
      for (const p of points) {
        const delta = at - p
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
          best = { delta, at, other }
        }
      }
    }
  }
  return best
}

const guide = (axis: 'x' | 'y', match: Match, rect: Rect): Guide =>
  axis === 'x'
    ? { axis, at: match.at, from: Math.min(rect.y, match.other.y), to: Math.max(rect.y + rect.height, match.other.y + match.other.height) }
    : { axis, at: match.at, from: Math.min(rect.x, match.other.x), to: Math.max(rect.x + rect.width, match.other.x + match.other.width) }

/** `moving` is where the pointer would put the frame; the result is where it
 *  lands. `zoom` turns the screen threshold into world units. For a
 *  multi-select move `moving` is the selection's bounding box and the same
 *  delta is applied to every member by the caller. */
export function snapMove(moving: Rect, others: readonly Rect[], zoom: number): SnapResult {
  const threshold = SNAP_PX / zoom
  const mx = nearest(xs(moving), others, xs, threshold)
  const my = nearest(ys(moving), others, ys, threshold)
  const rect = { ...moving, x: moving.x + (mx?.delta ?? 0), y: moving.y + (my?.delta ?? 0) }
  return {
    rect,
    guides: [...(mx ? [guide('x', mx, rect)] : []), ...(my ? [guide('y', my, rect)] : [])],
  }
}

/** Resizing snaps only the edges being dragged; the opposite edge is fixed. */
export function snapResize(
  resizing: Rect,
  handle: ResizeHandle,
  others: readonly Rect[],
  zoom: number,
  min: { width: number; height: number },
): SnapResult {
  const threshold = SNAP_PX / zoom
  let { x, y, width, height } = resizing
  const right = x + width
  const bottom = y + height
  const guides: Guide[] = []
  const edges = (r: Rect) => [r.x, r.x + r.width]
  const rows = (r: Rect) => [r.y, r.y + r.height]
  if (handle.includes('e')) {
    const m = nearest([right], others, edges, threshold)
    width = Math.max(min.width, width + (m?.delta ?? 0))
    if (m) guides.push(guide('x', m, { x, y, width, height }))
  } else if (handle.includes('w')) {
    const m = nearest([x], others, edges, threshold)
    const left = Math.min(right - min.width, x + (m?.delta ?? 0))
    width = right - left
    x = left
    if (m) guides.push(guide('x', m, { x, y, width, height }))
  }
  if (handle.includes('s')) {
    const m = nearest([bottom], others, rows, threshold)
    height = Math.max(min.height, height + (m?.delta ?? 0))
    if (m) guides.push(guide('y', m, { x, y, width, height }))
  } else if (handle.includes('n')) {
    const m = nearest([y], others, rows, threshold)
    const top = Math.min(bottom - min.height, y + (m?.delta ?? 0))
    height = bottom - top
    y = top
    if (m) guides.push(guide('y', m, { x, y, width, height }))
  }
  return { rect: { x, y, width, height }, guides }
}
