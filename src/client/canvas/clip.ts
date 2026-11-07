/** Frames on the clipboard, by reference. What is copied is which frames, on
 *  which canvas, of which project - never their documents or their images: the
 *  daemon clones those when they are pasted, so a copy of a dozen pages is a few
 *  hundred bytes however large they are. Carried as a type of its own, which a
 *  field never pastes as text. */

import { type CanvasId, asCanvasId, asFrameId } from '../../canvas/types.js'
import type { FrameWire } from '../../canvas/wire.js'

export const FRAME_CLIP_TYPE = 'application/x-ezdesign-frames'

export interface FrameClip {
  /** The session that copied them. A project is served from one origin, and its
   *  canvases are the only ones a paste can reach. */
  origin: string
  canvasId: CanvasId
  /** As the board showed them, bottom to top: what a paste draws until the
   *  daemon has made the copies. */
  frames: FrameWire[]
}

export function writeFrameClip(data: DataTransfer, clip: FrameClip): void {
  data.setData(FRAME_CLIP_TYPE, JSON.stringify(clip))
}

export function hasFrameClip(data: Pick<DataTransfer, 'types'> | null): boolean {
  return !!data?.types.includes(FRAME_CLIP_TYPE)
}

export function readFrameClip(data: Pick<DataTransfer, 'getData'> | null): FrameClip | null {
  const raw = data?.getData(FRAME_CLIP_TYPE)
  if (!raw) return null
  try {
    const clip = JSON.parse(raw) as Partial<FrameClip>
    const canvasId = asCanvasId(clip.canvasId)
    const frames = Array.isArray(clip.frames) ? clip.frames.filter(isFrameWire) : []
    if (typeof clip.origin !== 'string' || !canvasId || !frames.length || frames.length !== clip.frames!.length) return null
    return { origin: clip.origin, canvasId, frames }
  } catch {
    return null
  }
}

function isFrameWire(raw: unknown): raw is FrameWire {
  const f = raw as Partial<FrameWire> | null
  const r = f?.rect
  return (
    !!f &&
    !!asFrameId(f.id) &&
    typeof f.title === 'string' &&
    (f.kind === 'page' || f.kind === 'image') &&
    typeof f.file === 'string' &&
    typeof f.hash === 'string' &&
    typeof f.src === 'string' &&
    !!r &&
    [r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n))
  )
}
