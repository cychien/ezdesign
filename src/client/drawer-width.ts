/** The library drawer's resize rule, kept out of the shell so it can be tested.
 *  The drawer pushes the page rather than covering it, so it shares the stage's
 *  floor with the sidebar: what both leave over is never under `STAGE_MIN`. */

import { STAGE_MIN } from './sidebar-width.js'

export const DRAWER_DEFAULT = 336
/** Two cards side by side, each still large enough to tell apart. */
export const DRAWER_MIN = 272
export const DRAWER_MAX = 640

/** `room` is what the page and the drawer share: the window less the sidebar
 *  and the activity bar. The floor outranks the stage, as the sidebar's does. */
export function maxDrawerWidth(room: number): number {
  return Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, room - STAGE_MIN))
}

export function clampDrawerWidth(width: number, room: number): number {
  return Math.round(Math.min(Math.max(width, DRAWER_MIN), maxDrawerWidth(room)))
}
