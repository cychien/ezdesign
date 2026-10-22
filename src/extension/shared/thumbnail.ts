import { thumbnailSize } from '../../library/policy.js'
import { toBase64 } from './bytes.js'
import type { EncodedThumb, Size } from './messages.js'

export const THUMBNAIL_TYPE = 'image/webp'
export const THUMBNAIL_QUALITY = 0.8

/** Rejects with the canvas's `SecurityError` when `source` is tainted. */
export async function encodeThumbnail(source: CanvasImageSource, size: Size): Promise<EncodedThumb> {
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
  return { webp: toBase64(new Uint8Array(await blob.arrayBuffer())), ...target, source: { ...size } }
}

export async function encodePng(source: CanvasImageSource, size: Size): Promise<string> {
  const canvas = new OffscreenCanvas(size.width, size.height)
  canvas.getContext('2d')!.drawImage(source, 0, 0, size.width, size.height)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return toBase64(new Uint8Array(await blob.arrayBuffer()))
}
