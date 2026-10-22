import { toBase64 } from '../shared/bytes.js'
import type { FrameGrab, Inspection, ViewportRect } from '../shared/messages.js'
import { encodePng, encodeThumbnail } from '../shared/thumbnail.js'

type Media = HTMLImageElement | HTMLVideoElement

let inspected: Media | null = null

function sourcesOf(el: Media): string[] {
  const own = [el.currentSrc, el.getAttribute('src') ? el.src : '']
  if (el instanceof HTMLVideoElement) own.push(...[...el.querySelectorAll('source')].map((s) => s.src))
  return own.filter(Boolean)
}

function visibleArea(el: Element): number {
  const r = el.getBoundingClientRect()
  const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
  const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0))
  return w * h
}

export function findMedia(srcUrl: string, mediaType: 'image' | 'video'): Media | null {
  const all = [...document.querySelectorAll<Media>(mediaType === 'image' ? 'img' : 'video')]
  const matches = all.filter((el) => sourcesOf(el).includes(srcUrl))
  if (matches.length <= 1) return matches[0] ?? null
  return (
    matches.find((el) => el.matches(':hover')) ??
    matches.sort((a, b) => visibleArea(b) - visibleArea(a))[0]!
  )
}

function clippedRect(el: Element): ViewportRect | null {
  const r = el.getBoundingClientRect()
  const x = Math.max(0, r.left)
  const y = Math.max(0, r.top)
  const width = Math.min(innerWidth, r.right) - x
  const height = Math.min(innerHeight, r.bottom) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

export async function grabFrame(video: HTMLVideoElement, fullFrame: boolean): Promise<FrameGrab> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return { type: 'empty' }
  if (video.mediaKeys) return { type: 'protected' }
  const size = { width: video.videoWidth, height: video.videoHeight }
  try {
    const [thumb, png] = await Promise.all([encodeThumbnail(video, size), fullFrame ? encodePng(video, size) : null])
    return { type: 'encoded', thumb, png }
  } catch (error) {
    if ((error as DOMException).name === 'SecurityError') return { type: 'tainted' }
    throw error
  }
}

export async function inspectMedia(srcUrl: string, mediaType: 'image' | 'video', fullFrame: boolean): Promise<Inspection> {
  const el = findMedia(srcUrl, mediaType)
  inspected = el
  const viewport = { width: innerWidth, height: innerHeight }
  if (!el) return { found: false, viewport, rect: null, natural: null, video: null }
  const natural =
    el instanceof HTMLVideoElement
      ? { width: el.videoWidth, height: el.videoHeight }
      : { width: el.naturalWidth, height: el.naturalHeight }
  return {
    found: true,
    viewport,
    rect: clippedRect(el),
    natural: natural.width && natural.height ? natural : null,
    video: el instanceof HTMLVideoElement ? { currentTime: el.currentTime, frame: await grabFrame(el, fullFrame) } : null,
  }
}

export function lastInspected(): Media | null {
  return inspected?.isConnected ? inspected : null
}

export async function readBytes(url: string): Promise<string | null> {
  try {
    return toBase64(new Uint8Array(await (await fetch(url)).arrayBuffer()))
  } catch {
    return null
  }
}
