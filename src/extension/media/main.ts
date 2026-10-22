import { fromBase64, toBase64 } from '../shared/bytes.js'
import { deviceCrop } from '../shared/geometry.js'
import type { EncodedThumb, MediaReplies, MediaRequest } from '../shared/messages.js'
import { encodeThumbnail } from '../shared/thumbnail.js'

const fed = new Map<string, Uint8Array[]>()

/** Raster images decode off the main thread through `createImageBitmap`; SVG,
 *  which it refuses, goes through an `<img>`. The `load` event, not
 *  `decode()`: a document that never renders never settles `decode()`. */
async function thumbnailOf(pieces: Uint8Array[]): Promise<EncodedThumb | null> {
  const blob = new Blob(pieces as BlobPart[])
  const bitmap = await createImageBitmap(blob).catch(() => null)
  if (bitmap) {
    try {
      return await encodeThumbnail(bitmap, { width: bitmap.width, height: bitmap.height })
    } finally {
      bitmap.close()
    }
  }
  const url = URL.createObjectURL(new Blob(pieces as BlobPart[], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('cannot decode'))
      img.src = url
    })
    if (!img.naturalWidth || !img.naturalHeight) return null
    return await encodeThumbnail(img, { width: img.naturalWidth, height: img.naturalHeight })
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function videoFrameOf(pieces: Uint8Array[], at: number): Promise<EncodedThumb | null> {
  const url = URL.createObjectURL(new Blob(pieces as BlobPart[]))
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  try {
    const ready = (event: string) =>
      new Promise<void>((resolve, reject) => {
        video.addEventListener(event, () => resolve(), { once: true })
        video.addEventListener('error', () => reject(new Error('cannot decode the video')), { once: true })
      })
    video.src = url
    await ready('loadeddata')
    video.currentTime = Math.min(at, Math.max(0, video.duration - 0.001))
    await ready('seeked')
    if (!video.videoWidth) return null
    return await encodeThumbnail(video, { width: video.videoWidth, height: video.videoHeight })
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

async function crop(request: Extract<MediaRequest, { type: 'crop' }>): Promise<MediaReplies['crop']> {
  const blob = await (await fetch(request.screenshot)).blob()
  const whole = await createImageBitmap(blob)
  const image = { width: whole.width, height: whole.height }
  const box = request.rect ? deviceCrop(request.rect, request.viewport, image) : { x: 0, y: 0, ...image }
  if (box.width < 1 || box.height < 1) return { original: null, thumb: null }
  const bitmap = await createImageBitmap(whole, box.x, box.y, box.width, box.height)
  const size = { width: box.width, height: box.height }
  const png = async () => {
    if (!request.original) return null
    const canvas = new OffscreenCanvas(size.width, size.height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    const out = await canvas.convertToBlob({ type: 'image/png' })
    return { png: toBase64(new Uint8Array(await out.arrayBuffer())), size }
  }
  const [thumb, original] = await Promise.all([encodeThumbnail(bitmap, size), png()])
  return { original, thumb }
}

async function handle(request: MediaRequest): Promise<unknown> {
  switch (request.type) {
    case 'feed':
      fed.set(request.job, [...(fed.get(request.job) ?? []), fromBase64(request.data)])
      return {}
    case 'thumbnail': {
      const pieces = fed.get(request.job) ?? []
      fed.delete(request.job)
      return { thumb: request.at === null ? await thumbnailOf(pieces) : await videoFrameOf(pieces, request.at) }
    }
    case 'crop':
      return crop(request)
    case 'drop':
      fed.delete(request.job)
      return {}
  }
}

function emptyReply(request: MediaRequest): unknown {
  if (request.type === 'thumbnail') return { thumb: null }
  if (request.type === 'crop') return { original: null, thumb: null }
  return {}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const request = message as MediaRequest
  if (request?.to !== 'media' || sender.id !== chrome.runtime.id) return undefined
  void handle(request).then(sendResponse, () => sendResponse(emptyReply(request)))
  return true
})
