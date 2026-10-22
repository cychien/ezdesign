import type { ReceivingStage } from '../library/index.js'

export interface DownloadRequest {
  url: string
  /** The page the media sits on; many CDNs refuse hotlinks without it. */
  referer: string | null
  /** The browser's own, so a CDN that sniffs agents answers as it does the page. */
  userAgent: string
  signal: AbortSignal
  onProgress(received: number, total: number | null): void
}

export type DownloadOutcome =
  | { type: 'staged'; stage: ReceivingStage }
  | { type: 'refused'; status: number }
  | { type: 'failed'; status: number | null; message: string }
  | { type: 'cancelled' }

const PROGRESS_EVERY_MS = 100
export const STALL_TIMEOUT_MS = 30_000

export async function downloadInto(
  request: DownloadRequest,
  openStage: (expectedBytes: number | undefined) => ReceivingStage,
  stallTimeoutMs = STALL_TIMEOUT_MS,
): Promise<DownloadOutcome> {
  const fetchAbort = new AbortController()
  const abortFetch = () => fetchAbort.abort()
  request.signal.addEventListener('abort', abortFetch, { once: true })
  let stage: ReceivingStage | null = null
  let stalled = false
  let stallTimer: NodeJS.Timeout | null = null
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      stalled = true
      fetchAbort.abort()
    }, stallTimeoutMs)
  }
  try {
    armStall()
    const headers: Record<string, string> = {
      'user-agent': request.userAgent,
      accept: 'image/avif,image/webp,image/*,video/*,*/*;q=0.8',
    }
    if (request.referer) headers.referer = request.referer
    const response = await fetch(request.url, { headers, redirect: 'follow', signal: fetchAbort.signal })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      return { type: 'refused', status: response.status }
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      return { type: 'failed', status: response.status, message: `the source answered ${response.status}` }
    }
    const declared = Number(response.headers.get('content-length'))
    const total = Number.isSafeInteger(declared) && declared > 0 ? declared : null
    stage = openStage(total ?? undefined)
    let received = 0
    let reported = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      armStall()
      received += value.length
      if ((await stage.write(value)) === 'over-cap') {
        await reader.cancel()
        break
      }
      const now = Date.now()
      if (now - reported >= PROGRESS_EVERY_MS) {
        reported = now
        request.onProgress(received, total)
      }
    }
    return { type: 'staged', stage }
  } catch (error) {
    await stage?.discard()
    if (request.signal.aborted) return { type: 'cancelled' }
    if (stalled) return { type: 'failed', status: null, message: `the source sent nothing for ${stallTimeoutMs / 1000} s` }
    return { type: 'failed', status: null, message: (error as Error).message }
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    request.signal.removeEventListener('abort', abortFetch)
  }
}
