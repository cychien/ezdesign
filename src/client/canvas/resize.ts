/** Resizing an image frame by one of its eight handles, as Figma does with an
 *  image: the aspect always holds, the opposite corner or edge stays put, and
 *  Alt resizes about the centre. Pure, so the geometry is testable without a
 *  DOM. */

import type { Point, Rect, Size } from '../../canvas/types.js'

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type Handle = (typeof HANDLES)[number]

/** -1 for the side a handle drags left or up, 1 for right or down, 0 for neither. */
function signs(handle: Handle): { x: number; y: number } {
  return {
    x: handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0,
    y: handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0,
  }
}

/** `start` dragged by `handle` through `delta` (world units). A corner follows
 *  the pointer along its diagonal; an edge scales by its own axis and keeps the
 *  other centred. */
export function resizedRect(
  start: Rect,
  handle: Handle,
  delta: Point,
  opts: { fromCenter: boolean; min: Size; max: Size },
): Rect {
  const { x: sx, y: sy } = signs(handle)
  const reach = opts.fromCenter ? 2 : 1
  const { width: w, height: h } = start
  const scale =
    sx && sy
      ? 1 + (reach * (sx * delta.x * w + sy * delta.y * h)) / (w * w + h * h)
      : sx
        ? 1 + (reach * sx * delta.x) / w
        : 1 + (reach * sy * delta.y) / h
  const lowest = Math.max(opts.min.width / w, opts.min.height / h)
  const highest = Math.min(opts.max.width / w, opts.max.height / h)
  const s = Math.min(highest, Math.max(lowest, scale))
  const width = Math.round(w * s)
  const height = Math.round(h * s)
  const along = (from: number, size: number, next: number, sign: number) =>
    opts.fromCenter || sign === 0 ? from + (size - next) / 2 : sign > 0 ? from : from + size - next
  return {
    x: Math.round(along(start.x, w, width, sx)),
    y: Math.round(along(start.y, h, height, sy)),
    width,
    height,
  }
}
