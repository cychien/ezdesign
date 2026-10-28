import { MAX_DIGEST_BYTES, type VideoSettleWire, type VideoStatusWire } from '../../attachment-wire.js'
import type { DigestFailure } from '../../protocol.js'
import { type FrameSource, openFrames } from './frames.js'
import { type Clip, type DigestPlan, type SheetPlan, planDigest } from './plan.js'
import { type FrameChange, changedRegions, signatureGrid } from './signature.js'

export interface DigestJob {
  id: string
  api: string
}

export type DigestEvent =
  | { id: string; type: 'progress'; fraction: number }
  | { id: string; type: 'done'; status: VideoStatusWire }
  | { id: string; type: 'error'; message: string }

const ANALYSE_SHARE = 0.7
const SHEET_QUALITIES = [0.9, 0.8, 0.7, 0.6] as const
const PROGRESS_EVERY_MS = 100
const MARK_COLOUR = '#ff2d55'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<DigestJob>) => void) | null
  postMessage(event: DigestEvent): void
}

scope.onmessage = (e) =>
  void digest(e.data).catch((error: unknown) =>
    scope.postMessage({ id: e.data.id, type: 'error', message: error instanceof Error ? error.message : String(error) }),
  )

async function digest(job: DigestJob): Promise<void> {
  const done = (status: VideoStatusWire) => scope.postMessage({ id: job.id, type: 'done', status })
  let lastPost = 0
  const progress = (fraction: number) => {
    const now = performance.now()
    if (now - lastPost < PROGRESS_EVERY_MS) return
    lastPost = now
    scope.postMessage({ id: job.id, type: 'progress', fraction })
  }
  if (!('VideoDecoder' in self) || !('OffscreenCanvas' in self)) {
    return done(await fail(job, 'unsupported-browser', navigator.userAgent))
  }
  const content = `${job.api}/attachments/${job.id}/content`
  let source: FrameSource | null = null
  try {
    const opened = await openFrames(content)
    if ('failed' in opened) {
      if (await gone(content)) return done({ state: 'gone' })
      return done(await fail(job, opened.failed, opened.detail))
    }
    source = opened.ok
    const clip = await analyse(source, (f) => progress(f * ANALYSE_SHARE))
    if (!clip.frames.length) return done(await fail(job, 'unreadable', 'no frames decoded'))
    const plan = planDigest(clip)
    const sheets = await render(source, plan, (f) => progress(ANALYSE_SHARE + f * (1 - ANALYSE_SHARE)))
    if (!sheets) return done(await fail(job, 'unreadable', 'too much detail to fit the digest'))
    done(
      await settle(job, {
        state: 'ready',
        durationMs: Math.max(1, Math.round(clip.durationUs / 1000)),
        width: clip.width,
        height: clip.height,
        fps: fpsOf(clip),
        audio: source.audio,
        motion: plan.motion,
        sheets: await Promise.all(sheets.map(base64)),
      }),
    )
  } catch (error) {
    if (await gone(content)) return done({ state: 'gone' })
    done(await fail(job, 'unreadable', error instanceof Error ? error.message : String(error)))
  } finally {
    source?.close()
  }
}

async function analyse(source: FrameSource, progress: (fraction: number) => void): Promise<Clip> {
  const grid = signatureGrid(source)
  const canvas = new OffscreenCanvas(grid.width, grid.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const whole = { x: 0, y: 0, width: source.width, height: source.height }
  const into = { x: 0, y: 0, width: grid.width, height: grid.height }
  const frames: FrameChange[] = []
  let prev: Uint8ClampedArray | null = null
  for await (const frame of source.all()) {
    try {
      frame.draw(ctx, whole, into)
    } finally {
      frame.close()
    }
    const next = ctx.getImageData(0, 0, grid.width, grid.height).data
    frames.push({ t: frame.t, regions: prev ? changedRegions(prev, next, grid) : [] })
    prev = next
    if (source.durationUs > 0) progress(Math.min(1, frame.t / source.durationUs))
  }
  const durationUs = Math.max(source.durationUs, frames.at(-1)?.t ?? 0)
  return { width: source.width, height: source.height, grid, frames, durationUs }
}

async function render(
  source: FrameSource,
  plan: DigestPlan,
  progress: (fraction: number) => void,
): Promise<Blob[] | null> {
  const canvases = plan.sheets.map((sheet) => paintBlank(sheet))
  const cellsAt = new Map<number, { ctx: OffscreenCanvasRenderingContext2D; cell: SheetPlan['cells'][number] }[]>()
  plan.sheets.forEach((sheet, i) => {
    for (const cell of sheet.cells) {
      const list = cellsAt.get(cell.t) ?? []
      list.push({ ctx: canvases[i]!.getContext('2d')!, cell })
      cellsAt.set(cell.t, list)
    }
  })
  let drawn = 0
  for await (const frame of source.at(plan.wanted)) {
    try {
      for (const { ctx, cell } of cellsAt.get(frame.t) ?? []) {
        ctx.imageSmoothingEnabled = !cell.pixelated
        frame.draw(ctx, cell.src, cell.dst)
        paintLabel(ctx, cell)
      }
    } finally {
      frame.close()
    }
    progress(++drawn / plan.wanted.length)
  }
  for (const quality of SHEET_QUALITIES) {
    const blobs = await Promise.all(canvases.map((c) => c.convertToBlob({ type: 'image/jpeg', quality })))
    if (blobs.reduce((sum, b) => sum + b.size, 0) <= MAX_DIGEST_BYTES) return blobs
  }
  return null
}

function paintBlank(sheet: SheetPlan): OffscreenCanvas {
  const canvas = new OffscreenCanvas(sheet.width, sheet.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, sheet.width, sheet.height)
  ctx.fillStyle = '#111111'
  ctx.font = '600 15px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(sheet.header, 8, 14, sheet.width - 16)
  return canvas
}

function paintLabel(ctx: OffscreenCanvasRenderingContext2D, cell: SheetPlan['cells'][number]): void {
  ctx.fillStyle = '#111111'
  ctx.font = '13px ui-monospace, monospace'
  ctx.textBaseline = 'bottom'
  ctx.fillText(cell.label, cell.dst.x, cell.dst.y - 3, cell.dst.width)
  for (const mark of cell.marks) {
    ctx.strokeStyle = MARK_COLOUR
    ctx.lineWidth = 2
    ctx.strokeRect(mark.rect.x, mark.rect.y, mark.rect.width, mark.rect.height)
    ctx.font = '700 13px system-ui, sans-serif'
    const w = ctx.measureText(mark.text).width + 8
    ctx.fillStyle = MARK_COLOUR
    ctx.fillRect(mark.rect.x, mark.rect.y, w, 18)
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.fillText(mark.text, mark.rect.x + 4, mark.rect.y + 9)
  }
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

async function gone(content: string): Promise<boolean> {
  const res = await fetch(content, { method: 'HEAD' }).catch(() => null)
  return res?.status === 404
}

async function settle(job: DigestJob, body: VideoSettleWire): Promise<VideoStatusWire> {
  const res = await fetch(`${job.api}/attachments/${job.id}/video`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 404) return { state: 'gone' }
  const answer = (await res.json().catch(() => null)) as VideoStatusWire | { error: string } | null
  if (!res.ok || !answer || !('state' in answer)) {
    throw new Error(answer && 'error' in answer ? answer.error : `HTTP ${res.status}`)
  }
  return answer
}

function fail(job: DigestJob, reason: DigestFailure, detail: string): Promise<VideoStatusWire> {
  return settle(job, { state: 'failed', reason, detail: detail.slice(0, 500) })
}

function fpsOf(clip: Clip): number {
  const gaps = clip.frames
    .slice(1)
    .map((f, i) => f.t - clip.frames[i]!.t)
    .filter((g) => g > 0)
    .sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  return median ? Math.max(1, Math.round(1e6 / median)) : 1
}
