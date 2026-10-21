/** The board's camera: pure math, tested without a DOM.
 *
 *  World coordinates are CSS pixels at zoom 1 and are what rects on disk are
 *  in. Screen coordinates are pixels inside the board element. The board draws
 *  one `transform` on its world element per animation frame and nothing else
 *  moves, which keeps a pan at compositor cost. */

import { type Camera, type Point, type Rect, type Size, ZOOM_MAX, ZOOM_MIN } from '../../canvas/types.js'

export function screenToWorld(camera: Camera, p: Point): Point {
  return { x: camera.x + p.x / camera.zoom, y: camera.y + p.y / camera.zoom }
}

export function worldToScreen(camera: Camera, p: Point): Point {
  return { x: (p.x - camera.x) * camera.zoom, y: (p.y - camera.y) * camera.zoom }
}

/** Pan by a screen delta. */
export function panned(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom }
}

export const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))

/** Zoom by `factor` keeping the world point under `at` (screen) where it is,
 *  clamped to `[ZOOM_MIN, ZOOM_MAX]`. */
export function zoomedAround(camera: Camera, factor: number, at: Point): Camera {
  const zoom = clampZoom(camera.zoom * factor)
  const anchor = screenToWorld(camera, at)
  return { x: anchor.x - at.x / zoom, y: anchor.y - at.y / zoom, zoom }
}

/** Every rect inside the stage with `padding` screen px, centred; zoom never
 *  above 1. The fit-all button, and the first paint of a canvas with no saved
 *  camera. An empty canvas gets `{0, 0, 1}`. */
export function fitAll(rects: readonly Rect[], stage: Size, padding = 48): Camera {
  if (rects.length === 0) return { x: 0, y: 0, zoom: 1 }
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  const room = { width: Math.max(1, stage.width - 2 * padding), height: Math.max(1, stage.height - 2 * padding) }
  const zoom = clampZoom(Math.min(1, room.width / (right - left), room.height / (bottom - top)))
  return {
    x: (left + right) / 2 - stage.width / 2 / zoom,
    y: (top + bottom) / 2 - stage.height / 2 / zoom,
    zoom,
  }
}

/** A camera read back from `view.json`: anything not finite or out of range
 *  becomes `fallback` rather than a blank board. */
export function sanitizeCamera(raw: unknown, fallback: Camera): Camera {
  if (typeof raw !== 'object' || raw === null) return fallback
  const { x, y, zoom } = raw as Record<string, unknown>
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!finite(x) || !finite(y) || !finite(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX) return fallback
  return { x, y, zoom }
}

/** The visible world rectangle, grown by `margin` screen px on every side. */
export function viewportRect(camera: Camera, stage: Size, margin = 0): Rect {
  return {
    x: camera.x - margin / camera.zoom,
    y: camera.y - margin / camera.zoom,
    width: (stage.width + 2 * margin) / camera.zoom,
    height: (stage.height + 2 * margin) / camera.zoom,
  }
}

export function intersects(a: Rect, b: Rect): boolean {
  return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y)
}

/** The world element's transform. One string, built in one place. */
export function worldTransform(camera: Camera): string {
  return `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px) scale(${camera.zoom})`
}
