import type { DeviceRect, Size, ViewportRect } from './messages.js'

/** Keeps an edge that lands on a whole pixel from rounding a pixel outward. */
const EDGE_EPSILON = 1e-6

export function deviceCrop(rect: ViewportRect, viewport: Size, image: Size): DeviceRect {
  const sx = image.width / viewport.width
  const sy = image.height / viewport.height
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v))
  const x0 = clamp(Math.floor(rect.x * sx + EDGE_EPSILON), image.width)
  const y0 = clamp(Math.floor(rect.y * sy + EDGE_EPSILON), image.height)
  const x1 = clamp(Math.ceil((rect.x + rect.width) * sx - EDGE_EPSILON), image.width)
  const y1 = clamp(Math.ceil((rect.y + rect.height) * sy - EDGE_EPSILON), image.height)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
