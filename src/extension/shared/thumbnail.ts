import { encodeThumbnail as encodeWebp } from '../../client/thumbnail.js'
import { toBase64 } from './bytes.js'
import type { EncodedThumb, Size } from './messages.js'

/** Rejects with the canvas's `SecurityError` when `source` is tainted. */
export async function encodeThumbnail(source: CanvasImageSource, size: Size): Promise<EncodedThumb> {
  const thumb = await encodeWebp(source, size)
  return { ...thumb, webp: toBase64(thumb.webp) }
}

export async function encodePng(source: CanvasImageSource, size: Size): Promise<string> {
  const canvas = new OffscreenCanvas(size.width, size.height)
  canvas.getContext('2d')!.drawImage(source, 0, 0, size.width, size.height)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return toBase64(new Uint8Array(await blob.arrayBuffer()))
}
