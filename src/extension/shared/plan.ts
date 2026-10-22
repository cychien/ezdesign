import type { CaptureKind, FrameGrab } from './messages.js'

export interface MenuClick {
  mediaType?: string
  srcUrl?: string
  pageUrl?: string
  frameId?: number
}

export interface TabRef {
  id: number
  windowId: number
  url?: string
  title?: string
}

export type Trigger =
  | { type: 'menu'; click: MenuClick; tab: TabRef }
  | { type: 'region'; tab: TabRef }

export type BytePath =
  | { via: 'host-download'; url: string }
  | { via: 'worker-fetch'; url: string }
  | { via: 'page-read'; url: string }
  | { via: 'screenshot' }
  | { via: 'none' }

export type ThumbPath =
  | { from: 'staged-bytes' }
  | { from: 'held-bytes' }
  | { from: 'page-frame' }
  | { from: 'none' }

export interface CapturePlan {
  kind: CaptureKind
  bytes: BytePath
  thumb: ThumbPath
  preview: 'element-bitmap' | 'screenshot' | 'media-url'
  dialog: 'page' | 'window'
  region: 'drag' | 'viewport' | null
}

const RESTRICTED = [
  /^chrome:/i,
  /^chrome-extension:/i,
  /^edge:/i,
  /^brave:/i,
  /^about:/i,
  /^view-source:/i,
  /^devtools:/i,
  /^https:\/\/chromewebstore\.google\.com\//i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/microsoftedge\.microsoft\.com\/addons/i,
]

export function isRestrictedPage(url: string | undefined): boolean {
  return url !== undefined && RESTRICTED.some((r) => r.test(url))
}

const isHttp = (url: string) => /^https?:\/\//i.test(url)

export function planCapture(trigger: Trigger): CapturePlan | null {
  if (trigger.type === 'region') {
    const restricted = isRestrictedPage(trigger.tab.url)
    return {
      kind: 'screenshot',
      bytes: { via: 'screenshot' },
      thumb: { from: 'held-bytes' },
      preview: 'screenshot',
      dialog: restricted ? 'window' : 'page',
      region: restricted ? 'viewport' : 'drag',
    }
  }
  const { mediaType, srcUrl, pageUrl } = trigger.click
  if (!srcUrl || (mediaType !== 'image' && mediaType !== 'video')) return null
  const restricted = isRestrictedPage(pageUrl ?? trigger.tab.url)
  const dialog = restricted ? 'window' : 'page'
  const preview = restricted ? 'media-url' : 'element-bitmap'
  if (mediaType === 'image') {
    if (isHttp(srcUrl)) {
      return { kind: 'image', bytes: { via: 'host-download', url: srcUrl }, thumb: { from: 'staged-bytes' }, preview, dialog, region: null }
    }
    if (restricted) return null
    return { kind: 'image', bytes: { via: 'page-read', url: srcUrl }, thumb: { from: 'held-bytes' }, preview, dialog, region: null }
  }
  const thumb: ThumbPath = restricted ? { from: 'none' } : { from: 'page-frame' }
  if (isHttp(srcUrl)) {
    return { kind: 'video', bytes: { via: 'host-download', url: srcUrl }, thumb, preview, dialog, region: null }
  }
  return { kind: 'video', bytes: { via: 'none' }, thumb, preview, dialog, region: null }
}

export function planAfterRefusal(plan: CapturePlan): CapturePlan {
  if (plan.bytes.via !== 'host-download' || plan.kind !== 'image') return plan
  return { ...plan, bytes: { via: 'worker-fetch', url: plan.bytes.url }, thumb: { from: 'held-bytes' } }
}

export function posterSource(grab: FrameGrab): 'frame' | 'screenshot' {
  return grab.type === 'encoded' ? 'frame' : 'screenshot'
}
