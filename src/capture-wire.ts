import { z } from 'zod'

export const HOST_NAME = 'com.cychien.ezdesign'

export const EXTENSION_ID = 'bgcgoejgebannhlbgfinbghahicahapb'

export const ALLOWED_ORIGINS: readonly string[] = [`chrome-extension://${EXTENSION_ID}/`]

export interface ProtocolRange {
  min: number
  max: number
}

/** The versions this build speaks. Raise `max` for any change a peer must
 *  understand; raise `min` only once a release has shipped speaking the new
 *  `max`, so an extension one update behind its host still connects. */
export const PROTOCOL: ProtocolRange = { min: 1, max: 1 }

/** Chrome's per-message caps. */
export const HOST_MESSAGE_MAX_BYTES = 1024 * 1024
export const EXTENSION_MESSAGE_MAX_BYTES = 64 * 1024 * 1024

export const HOST_CHUNK_BYTES = 720 * 1024

export const EXTENSION_CHUNK_BYTES = 8 * 1024 * 1024

export function negotiateProtocol(ours: ProtocolRange, theirs: ProtocolRange): number | null {
  const version = Math.min(ours.max, theirs.max)
  return version >= Math.max(ours.min, theirs.min) ? version : null
}

const RequestId = z.number().int().nonnegative()
/** Chosen by the extension, one per capture, and the only handle either side
 *  uses for it: a discard can name a capture whose download has not finished. */
const CaptureId = z.string().regex(/^[0-9A-Za-z_-]{8,64}$/)
const Range = z.object({ min: z.number().int(), max: z.number().int() })
const Dimensions = z.object({ width: z.number().int().positive(), height: z.number().int().positive() })
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const HttpUrl = z
  .string()
  .max(16_384)
  .refine((u) => /^https?:\/\//i.test(u), 'only http(s) is downloaded by the host')

const CaptureContext = z.object({
  pageUrl: z.string().max(16_384),
  pageTitle: z.string().max(4096),
  /** The media's own http(s) URL; null for screenshots and inline data. */
  mediaUrl: z.string().max(16_384).nullable(),
  capturedAt: z.number().int(),
})
export type CaptureContext = z.infer<typeof CaptureContext>

const Base64 = z.string()

export const Request = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    id: RequestId,
    protocol: Range,
    extension: z.object({ version: z.string() }),
  }),
  /** Host GETs `url` itself, sending `referer` and the browser's user agent. */
  z.object({
    t: z.literal('download'),
    id: RequestId,
    capture: CaptureId,
    kind: z.enum(['image', 'video']),
    url: HttpUrl,
    referer: z.string().max(16_384).nullable(),
    userAgent: z.string().max(1024),
    context: CaptureContext,
  }),
  /** Bytes the extension holds (a screenshot, a cookie fetch, inline data),
   *  or, as `frame`, the full-size PNG frame of a capture already staged as a
   *  link. Replied to at once; the bytes follow as `chunk` frames. */
  z.object({
    t: z.literal('upload'),
    id: RequestId,
    capture: CaptureId,
    kind: z.enum(['image', 'screenshot', 'frame']),
    size: z.number().int().nonnegative(),
    context: CaptureContext,
  }),
  /** No reply. `offset` must equal the bytes received so far, or the upload
   *  fails `integrity` at `upload-end`. */
  z.object({ t: z.literal('chunk'), capture: CaptureId, offset: z.number().int().nonnegative(), data: Base64 }),
  z.object({ t: z.literal('upload-end'), id: RequestId, capture: CaptureId, sha256: Sha256Hex }),
  /** A capture with nothing to download: a MediaSource or `blob:` video. */
  z.object({
    t: z.literal('link'),
    id: RequestId,
    capture: CaptureId,
    playbackTime: z.number().nonnegative().nullable(),
    context: CaptureContext,
  }),
  z.object({
    t: z.literal('thumbnail'),
    id: RequestId,
    capture: CaptureId,
    webp: Base64,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** The pixel size of what the thumbnail was made from. */
    source: Dimensions,
  }),
  /** Stream the staged bytes back as `bytes` frames, for the extension to
   *  make the thumbnail from. Replied to after the last frame. */
  z.object({ t: z.literal('read'), id: RequestId, capture: CaptureId }),
  /** Idempotent: a second commit of one capture replies with the first result. */
  z.object({
    t: z.literal('commit'),
    id: RequestId,
    capture: CaptureId,
    tags: z.array(z.string().max(256)).max(200),
    note: z.string().max(200_000),
  }),
  /** Idempotent, and valid at any point: aborts a running download or upload. */
  z.object({ t: z.literal('discard'), id: RequestId, capture: CaptureId }),
  z.object({
    t: z.literal('suggest'),
    id: RequestId,
    prefix: z.string().max(256),
    exclude: z.array(z.string().max(256)).max(200),
    limit: z.number().int().min(1).max(50),
  }),
  /** Aborts the request `ref` (a `download` or `read`), which then fails `cancelled`. */
  z.object({ t: z.literal('cancel'), ref: RequestId }),
])
export type Request = z.infer<typeof Request>
export type RequestType = Request['t']
export type AnsweredRequest = Exclude<Request, { t: 'chunk' } | { t: 'cancel' }>
export type AnsweredType = AnsweredRequest['t']

const WireItem = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  note: z.string(),
  hasThumbnail: z.boolean(),
})
export type WireItem = z.infer<typeof WireItem>

const Staged = z.object({
  /** `file`: bytes are staged. `stream-link`: nothing to download. `too-large`:
   *  a video over the cap, staged as a link with no bytes; the dialog says so. */
  outcome: z.enum(['file', 'stream-link', 'too-large']),
  bytes: z.number().int().nonnegative().nullable(),
  mediaType: z.string().nullable(),
  /** Set when the same bytes are already in the library (已收藏過). */
  duplicate: WireItem.nullable(),
})
export type Staged = z.infer<typeof Staged>

const Welcome = z.object({
  protocol: z.number().int(),
  host: z.object({ version: z.string(), node: z.string() }),
  library: z.object({ dir: z.string() }),
})
export type Welcome = z.infer<typeof Welcome>

const Done = z.object({})

/** Per request type, the shape of a successful answer. The extension parses a
 *  `result` with the schema of the request it sent under that id. */
export const ReplyValue = {
  hello: Welcome,
  download: Staged,
  upload: Done,
  'upload-end': Staged,
  link: Staged,
  thumbnail: Done,
  read: z.object({ bytes: z.number().int().nonnegative() }),
  commit: z.object({ item: WireItem, merged: z.boolean() }),
  discard: Done,
  suggest: z.object({ tags: z.array(z.object({ name: z.string(), uses: z.number().int() })).max(50) }),
} satisfies { [K in AnsweredType]: z.ZodType }
export type ReplyOf<K extends AnsweredType> = z.infer<(typeof ReplyValue)[K]>

export const WireError = z.discriminatedUnion('code', [
  /** The ranges do not meet. `host` lets the extension say which side is old. */
  z.object({ code: z.literal('incompatible'), message: z.string(), host: Range }),
  z.object({ code: z.literal('bad-request'), message: z.string() }),
  /** The source answered 401/403 to the host: the extension may fetch it with
   *  the page's cookies after the user grants that origin. */
  z.object({ code: z.literal('source-refused'), message: z.string(), status: z.number().int() }),
  z.object({ code: z.literal('source-failed'), message: z.string(), status: z.number().int().nullable() }),
  z.object({ code: z.literal('integrity'), message: z.string() }),
  /** The host has no such capture: it restarted since staging. Re-stage. */
  z.object({ code: z.literal('unknown-capture'), message: z.string() }),
  z.object({ code: z.literal('cancelled'), message: z.string() }),
  /** The library could not do it: node too old for `node:sqlite`, a schema from
   *  a newer ezdesign, a full disk. */
  z.object({ code: z.literal('library'), message: z.string(), retryable: z.boolean() }),
  z.object({ code: z.literal('internal'), message: z.string() }),
])
export type WireError = z.infer<typeof WireError>

export const HostMessage = z.discriminatedUnion('t', [
  /** `value` is parsed against `ReplyValue[<type of request re>]` by the receiver. */
  z.object({ t: z.literal('result'), re: RequestId, value: z.unknown() }),
  z.object({ t: z.literal('error'), re: RequestId, error: WireError }),
  z.object({
    t: z.literal('progress'),
    re: RequestId,
    received: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().nullable(),
  }),
  /** One piece of a `read`, at most `HOST_CHUNK_BYTES` raw. */
  z.object({ t: z.literal('bytes'), re: RequestId, seq: z.number().int().nonnegative(), data: Base64 }),
  /** The host is going away on its own, with no request to blame. */
  z.object({ t: z.literal('fatal'), error: WireError }),
])
export type HostMessage = z.infer<typeof HostMessage>

export function parseRequest(raw: unknown): { ok: true; request: Request } | { ok: false; error: WireError } {
  const parsed = Request.safeParse(raw)
  if (parsed.success) return { ok: true, request: parsed.data }
  return { ok: false, error: { code: 'bad-request', message: parsed.error.message.slice(0, 500) } }
}

export function parseHostMessage(raw: unknown): HostMessage | null {
  const parsed = HostMessage.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parseReply<K extends AnsweredType>(type: K, value: unknown): ReplyOf<K> | null {
  const parsed = ReplyValue[type].safeParse(value)
  return parsed.success ? (parsed.data as ReplyOf<K>) : null
}
