import type { DigestFailure, MotionStretch, VideoRect } from './protocol.js'

export const MAX_SHEETS = 6
export const MAX_SHEET_BYTES = 4 * 1024 * 1024
export const MAX_DIGEST_BYTES = 10 * 1024 * 1024
export const SETTLE_BODY_LIMIT = Math.ceil((MAX_DIGEST_BYTES * 4) / 3) + 256 * 1024

export type VideoSettleWire =
  | {
      state: 'ready'
      durationMs: number
      width: number
      height: number
      fps: number
      audio: boolean
      motion: MotionStretch[]
      sheets: string[]
    }
  | { state: 'failed'; reason: DigestFailure; detail: string }

export type VideoSettle =
  | {
      state: 'ready'
      durationMs: number
      width: number
      height: number
      fps: number
      audio: boolean
      motion: MotionStretch[]
      sheets: Uint8Array[]
    }
  | { state: 'failed'; reason: DigestFailure; detail: string }

export type VideoStatusWire =
  | { state: 'pending' }
  | { state: 'ready' }
  | { state: 'failed'; reason: DigestFailure }
  | { state: 'gone' }

const FAILURES: Record<DigestFailure, true> = {
  'unsupported-browser': true,
  'unsupported-codec': true,
  unreadable: true,
  crashed: true,
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
const count = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0

export function parseVideoSettle(raw: unknown): VideoSettle | string {
  if (typeof raw !== 'object' || raw === null) return 'a settle is an object'
  const r = raw as Record<string, unknown>
  if (r.state === 'failed') {
    if (typeof r.reason !== 'string' || !Object.hasOwn(FAILURES, r.reason)) return 'unknown failure reason'
    if (typeof r.detail !== 'string') return 'detail must be a string'
    return { state: 'failed', reason: r.reason as DigestFailure, detail: r.detail.slice(0, 500) }
  }
  if (r.state !== 'ready') return 'state must be ready or failed'
  const { durationMs, width, height, fps, audio } = r
  if (![durationMs, width, height, fps].every(positive)) return 'durationMs, width, height and fps must be positive'
  if (typeof audio !== 'boolean') return 'audio must be a boolean'
  const w = width as number
  const h = height as number

  if (!Array.isArray(r.sheets) || r.sheets.length < 1 || r.sheets.length > MAX_SHEETS) {
    return `sheets must hold 1 to ${MAX_SHEETS} images`
  }
  const sheets: Uint8Array[] = []
  let total = 0
  for (const sheet of r.sheets) {
    if (typeof sheet !== 'string' || !BASE64.test(sheet)) return 'a sheet must be base64'
    const bytes = new Uint8Array(Buffer.from(sheet, 'base64'))
    if (bytes.byteLength > MAX_SHEET_BYTES) return 'a sheet is too large'
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return 'a sheet must be a JPEG'
    total += bytes.byteLength
    sheets.push(bytes)
  }
  if (total > MAX_DIGEST_BYTES) return 'the sheets together are too large'

  if (!Array.isArray(r.motion)) return 'motion must be a list'
  const motion: MotionStretch[] = []
  const used = new Set<number>()
  let previous = -1
  for (const raw of r.motion as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return 'a stretch is an object'
    const m = raw as Record<string, unknown>
    if (!count(m.fromMs) || !count(m.toMs) || (m.toMs as number) < (m.fromMs as number)) {
      return 'a stretch needs fromMs <= toMs'
    }
    if ((m.fromMs as number) < previous) return 'stretches must be in time order'
    previous = m.fromMs as number
    if (!insideFrame(m.region, w, h)) return 'a stretch region must lie inside the frame'
    if (!count(m.frames) || !count(m.shown) || (m.shown as number) > (m.frames as number)) {
      return 'a stretch needs shown <= frames'
    }
    if (m.sheet === null) {
      if (m.shown !== 0) return 'a stretch without a sheet shows nothing'
    } else {
      if (!Number.isInteger(m.sheet) || (m.sheet as number) < 2 || (m.sheet as number) > sheets.length) {
        return 'a stretch names a sheet that is not there'
      }
      if (used.has(m.sheet as number)) return 'two stretches name one sheet'
      used.add(m.sheet as number)
    }
    const { x, y, width: rw, height: rh } = m.region as VideoRect
    motion.push({
      fromMs: m.fromMs as number,
      toMs: m.toMs as number,
      region: { x, y, width: rw, height: rh },
      frames: m.frames as number,
      shown: m.shown as number,
      sheet: m.sheet as number | null,
    })
  }
  if (used.size !== sheets.length - 1) return 'every sheet past the first belongs to a stretch'

  return { state: 'ready', durationMs: durationMs as number, width: w, height: h, fps: fps as number, audio, motion, sheets }
}

function insideFrame(raw: unknown, width: number, height: number): raw is VideoRect {
  if (typeof raw !== 'object' || raw === null) return false
  const { x, y, width: w, height: h } = raw as Record<string, unknown>
  return (
    count(x) &&
    count(y) &&
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    (w as number) > 0 &&
    (h as number) > 0 &&
    x + (w as number) <= width &&
    y + (h as number) <= height
  )
}
