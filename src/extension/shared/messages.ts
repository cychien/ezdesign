declare const captureBrand: unique symbol
export type CaptureId = string & { readonly [captureBrand]: 'CaptureId' }

export type CaptureKind = 'image' | 'screenshot' | 'video'

export interface Size {
  width: number
  height: number
}

export interface ViewportRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DeviceRect {
  x: number
  y: number
  width: number
  height: number
}

export interface EncodedThumb {
  webp: string
  width: number
  height: number
  source: Size
}

export type PageCommand =
  | { to: 'page'; type: 'select-region' }
  | { to: 'page'; type: 'inspect'; srcUrl: string; mediaType: 'image' | 'video'; fullFrame: boolean }
  | { to: 'page'; type: 'read'; url: string }
  | { to: 'page'; type: 'present'; captureId: CaptureId; dialogPath: string; nonce: string; bitmap: boolean }
  | { to: 'page'; type: 'dismiss'; captureId: CaptureId }
  | { to: 'page'; type: 'record'; captureId: CaptureId; srcUrl: string; maxSeconds: number }
  | { to: 'page'; type: 'recording-read'; captureId: CaptureId; offset: number; length: number }
  | { to: 'page'; type: 'recording-drop'; captureId: CaptureId }
  | { to: 'page'; type: 'pill'; captureId: CaptureId; text: string; tone: 'working' | 'done' | 'error' }

export interface PageReplies {
  'select-region': RegionChoice
  inspect: Inspection
  read: { data: string | null }
  /** A cross-origin image's bitmap is not origin-clean, and Chrome will not transfer one. */
  present: { mounted: boolean; handedOff: boolean }
  dismiss: Record<string, never>
  record: { ok: true; bytes: number } | { ok: false; reason: string }
  'recording-read': { data: string }
  'recording-drop': Record<string, never>
  pill: Record<string, never>
}

export interface Inspection {
  found: boolean
  viewport: Size
  rect: ViewportRect | null
  natural: Size | null
  video: { currentTime: number; duration: number | null; poster: string | null; frame: FrameGrab } | null
}

export type FrameGrab =
  | { type: 'encoded'; thumb: EncodedThumb; png: string | null }
  | { type: 'tainted' }
  | { type: 'protected' }
  | { type: 'empty' }

export type RegionChoice =
  | { type: 'rect'; rect: ViewportRect; viewport: Size; pickedAt: number }
  | { type: 'media'; mediaType: 'image' | 'video'; srcUrl: string; pickedAt: number }
  | { type: 'viewport'; viewport: Size; pickedAt: number }
  | { type: 'cancelled' }

export interface PreviewHandoff {
  type: 'ez-capture-preview'
  nonce: string
  bitmap: ImageBitmap
}

export interface DialogLeaving {
  type: 'ez-capture-leaving'
  how: 'saved' | 'cancelled'
}

export const DIALOG_PORT_PREFIX = 'dialog:'

export type DialogToWorker =
  | { type: 'confirm'; tags: string[]; note: string }
  | { type: 'cancel' }
  | { type: 'suggest'; prefix: string; exclude: string[] }
  | { type: 'granted'; origin: string }
  | { type: 'streams-granted' }
  | { type: 'denied'; origin: string }
  | { type: 'preview-shown'; at: number }
  | { type: 'closed' }

export type WorkerToDialog =
  | { type: 'preview'; preview: PreviewSource }
  | { type: 'view'; view: CaptureView }
  | { type: 'suggestions'; prefix: string; tags: { name: string; uses: number }[] }

/** `size` is the picture's pixel size when known before it loads, so the dialog
 *  can hold its place instead of growing when it arrives. */
export type PreviewSource =
  | { type: 'bitmap'; nonce: string; size: Size | null }
  | { type: 'screenshot'; dataUrl: string; rect: ViewportRect | null; viewport: Size }
  | { type: 'url'; src: string; fromScreen?: boolean; size: Size | null }
  | { type: 'none' }

export type HostState =
  | { type: 'connecting' }
  | { type: 'ready'; version: string; node: string; libraryDir: string; protocol: number }
  | { type: 'missing'; installCommand: string }
  | { type: 'incompatible'; older: 'host' | 'extension'; installCommand: string }
  | { type: 'broken'; message: string }

export type StagingView =
  | { type: 'pending' }
  | { type: 'progress'; received: number; total: number | null }
  | { type: 'recording'; seconds: number; total: number }
  | { type: 'staged'; bytes: number | null }
  | { type: 'needs-permission'; origin: string }
  | { type: 'failed'; message: string }

export interface CaptureView {
  captureId: CaptureId
  kind: CaptureKind
  page: { url: string; title: string }
  host: HostState
  staging: StagingView
  duplicate: { tags: string[]; note: string } | null
  notice: 'too-large' | 'stream-link' | 'record' | null
  recordSeconds: number | null
  finding: boolean
  offer: 'streams' | null
  confirm: 'enabled' | 'disabled' | 'saving' | 'saved' | 'failed'
  error: string | null
}

export type MediaRequest =
  | { to: 'media'; type: 'feed'; job: string; data: string }
  | { to: 'media'; type: 'thumbnail'; job: string; at: number | 'opening' | null }
  | { to: 'media'; type: 'crop'; job: string; screenshot: string; rect: ViewportRect | null; viewport: Size; original: boolean }
  | { to: 'media'; type: 'drop'; job: string }

export interface MediaReplies {
  feed: Record<string, never>
  thumbnail: { thumb: EncodedThumb | null }
  crop: { original: { png: string; size: Size } | null; thumb: EncodedThumb | null }
  drop: Record<string, never>
}

export type WorkerRequest =
  | { to: 'worker'; type: 'host-status'; recheck: boolean }
  | { to: 'worker'; type: 'record-progress'; captureId: CaptureId; seconds: number }
