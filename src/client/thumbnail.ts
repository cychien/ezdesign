/** The library's one thumbnail, made in the browser: by the extension for a
 *  capture, by the shell for a pasted image. Node has no WebP encoder. */

import { thumbnailSize } from '../library/policy.js'

export const THUMBNAIL_TYPE = 'image/webp'
export const THUMBNAIL_QUALITY = 0.8

export interface Size {
  width: number
  height: number
}

export interface WebpThumbnail {
  webp: Uint8Array<ArrayBuffer>
  width: number
  height: number
  source: Size
}

/** Rejects with the canvas's `SecurityError` when `source` is tainted. */
export async function encodeThumbnail(source: CanvasImageSource, size: Size): Promise<WebpThumbnail> {
  const target = thumbnailSize(size.width, size.height)
  let current: CanvasImageSource = source
  let { width, height } = size
  // One drawImage from far above the target aliases; halving steps keep detail.
  while (width / 2 >= target.width * 2 && height / 2 >= target.height * 2) {
    width = Math.round(width / 2)
    height = Math.round(height / 2)
    const step = new OffscreenCanvas(width, height)
    const ctx = step.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(current, 0, 0, width, height)
    current = step
  }
  const canvas = new OffscreenCanvas(target.width, target.height)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(current, 0, 0, target.width, target.height)
  const blob = await canvas.convertToBlob({ type: THUMBNAIL_TYPE, quality: THUMBNAIL_QUALITY })
  if (blob.type !== THUMBNAIL_TYPE) throw new Error(`this browser encodes ${blob.type}, not WebP`)
  return { webp: new Uint8Array(await blob.arrayBuffer()), ...target, source: { ...size } }
}
