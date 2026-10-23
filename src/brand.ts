/** The ezdesign mark and wordmark, the one source every surface draws from:
 *  the shell, its favicon, the capture extension and the README assets.
 *  docs/brand.md has the rules and how the raster copies are made. */

import { WORDMARK_PATH, WORDMARK_VIEWBOX } from './brand-wordmark.js'

const PIN = 'M3 26V16A13 13 0 1 1 16 29H6A3 3 0 0 1 3 26Z'

/** Sunset: --mark in the middle, so at a glance it is still the annotation orange. */
export const BRAND_SUNSET = ['#f7a160', '#e56d41', '#cf4a2c'] as const

/** `id` scopes the gradient, since every inline copy in one document shares an id space. */
export function brandMarkSvg(id = 'ez-sunset'): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>${markShapes(id)}</svg>`
}

/** Mark and wordmark side by side, in px at the shell header's 16px. */
export const LOCKUP = { markSize: 16, gap: 5, wordmarkHeight: 13 }

export function brandLockupSvg({ fill = 'currentColor', id = 'ez-sunset', height = LOCKUP.markSize } = {}): string {
  const { markSize, gap, wordmarkHeight } = LOCKUP
  const scale = wordmarkHeight / WORDMARK_VIEWBOX.height
  const wordmarkWidth = round(WORDMARK_VIEWBOX.width * scale)
  // Centred on ascender to baseline: counting the g's descender sits the mark low.
  const wordmarkY = round(markSize / 2 + (WORDMARK_VIEWBOX.y / 2) * scale)
  const width = markSize + gap + wordmarkWidth
  const size = height === markSize ? '' : ` width='${round((width * height) / markSize)}' height='${height}'`
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${markSize}'${size}>` +
    `<svg width='${markSize}' height='${markSize}' viewBox='0 0 32 32'>${markShapes(id)}</svg>` +
    `<svg x='${markSize + gap}' y='${wordmarkY}' width='${wordmarkWidth}' height='${wordmarkHeight}' viewBox='${wordmarkViewBox()}'>${wordmarkShape(fill)}</svg>` +
    `</svg>`
  )
}

function markShapes(id: string): string {
  const [from, mid, to] = BRAND_SUNSET
  return `<defs><linearGradient id='${id}' x1='0.15' y1='0.05' x2='0.85' y2='1'><stop offset='0' stop-color='${from}'/><stop offset='.55' stop-color='${mid}'/><stop offset='1' stop-color='${to}'/></linearGradient></defs><path d='${PIN}' fill='url(#${id})'/><circle cx='16' cy='16' r='4.4' fill='#fff'/>`
}

function wordmarkViewBox(): string {
  const { x, y, width, height } = WORDMARK_VIEWBOX
  return `${x} ${y} ${width} ${height}`
}

function wordmarkShape(fill: string): string {
  return `<path fill='${fill}' d='${WORDMARK_PATH}'/>`
}

const round = (n: number) => Math.round(n * 100) / 100

