/** Which frames have a live iframe: what keeps a 40-frame canvas usable within
 *  1.5 s of opening, pure so it is tested without a DOM.
 *
 *  - Cards for every frame are drawn at once; only iframes are rationed.
 *  - A frame is mounted when its rect meets the viewport grown by `OVERSCAN_PX`
 *    screen pixels, nearest the viewport centre first, while fewer than
 *    `MAX_CONCURRENT_LOADS` iframes are still loading - so what is on screen is
 *    requested first and six loads never starve the rest.
 *  - A mounted frame stays mounted when it scrolls away: unmounting reloads it
 *    on return and loses its scroll and state, which is churn the pan budget
 *    cannot afford. Only past `MOUNTED_SOFT_CAP` mounted frames are the farthest
 *    offscreen ones unmounted, back down to the cap - never a pinned one (the
 *    frame holding the popup, the pick, or the selection).
 *
 *  Re-planned when the camera settles and when a load finishes, never per
 *  animation frame. */

import type { Camera, FrameId, Rect, Size } from '../../canvas/types.js'
import { intersects, viewportRect } from './camera.js'

export const OVERSCAN_PX = 600
export const MAX_CONCURRENT_LOADS = 6
export const MOUNTED_SOFT_CAP = 60

export interface MountState {
  mounted: ReadonlySet<FrameId>
  /** Mounted, `load` not fired yet. */
  loading: ReadonlySet<FrameId>
  /** Never unmounted by this plan. */
  pinned: ReadonlySet<FrameId>
}

export interface MountPlan {
  mount: FrameId[]
  unmount: FrameId[]
}

/** O(n log n) in frames for the distance sort; 40 frames is microseconds. */
export function planMounts(
  frames: readonly { id: FrameId; rect: Rect }[],
  camera: Camera,
  stage: Size,
  state: MountState,
): MountPlan {
  const view = viewportRect(camera, stage, OVERSCAN_PX)
  const centre = { x: view.x + view.width / 2, y: view.y + view.height / 2 }
  const distance = (r: Rect) => Math.hypot(r.x + r.width / 2 - centre.x, r.y + r.height / 2 - centre.y)
  const inView = new Set(frames.filter((f) => intersects(f.rect, view)).map((f) => f.id))
  const mount = frames
    .filter((f) => inView.has(f.id) && !state.mounted.has(f.id))
    .sort((a, b) => distance(a.rect) - distance(b.rect))
    .slice(0, Math.max(0, MAX_CONCURRENT_LOADS - state.loading.size))
    .map((f) => f.id)
  const over = state.mounted.size + mount.length - MOUNTED_SOFT_CAP
  const unmount =
    over > 0
      ? frames
          .filter((f) => state.mounted.has(f.id) && !state.pinned.has(f.id) && !inView.has(f.id))
          .sort((a, b) => distance(b.rect) - distance(a.rect))
          .slice(0, over)
          .map((f) => f.id)
      : []
  return { mount, unmount }
}
