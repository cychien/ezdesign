import { ALL_FORMATS, BufferTarget, Conversion, HLS_FORMATS, Input, Mp4OutputFormat, Output, UrlSource } from 'mediabunny'
import type { ReceivingStage } from '../library/index.js'
import type { DownloadOutcome, DownloadRequest } from './download.js'

export type SourceKind = 'file' | 'hls'

const PROBE_TIMEOUT_MS = 8_000
const PARALLELISM = 6
const WRITE_PIECE = 1024 * 1024
const PROGRESS_STEPS = 1000

function headersOf(request: { referer: string | null; userAgent: string }): Record<string, string> {
  return { 'user-agent': request.userAgent, ...(request.referer ? { referer: request.referer } : {}) }
}

function openInput(url: string, kind: SourceKind, headers: Record<string, string>): Input {
  return new Input({
    formats: kind === 'hls' ? HLS_FORMATS : ALL_FORMATS,
    source: new UrlSource(url, { requestInit: { headers }, parallelism: PARALLELISM }),
  })
}

export async function probeSources(
  sources: readonly { url: string; as: SourceKind }[],
  request: { referer: string | null; userAgent: string },
): Promise<{ durations: (number | null)[]; masters: boolean[] }> {
  const headers = headersOf(request)
  const probed = await Promise.all(
    sources.map(async ({ url, as }) => {
      const input = openInput(url, as, headers)
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS).unref())
      try {
        const duration = (async () => ((await input.getPrimaryVideoTrack()) ? input.computeDuration() : null))()
        const master =
          as === 'hls'
            ? fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
                .then((res) => res.text())
                .then((text) => text.includes('#EXT-X-STREAM-INF'))
                .catch(() => false)
            : Promise.resolve(false)
        return {
          duration: await Promise.race([duration.catch(() => null), timeout]),
          master: await master,
        }
      } finally {
        input.dispose()
      }
    }),
  )
  return { durations: probed.map((p) => p.duration), masters: probed.map((p) => p.master) }
}

export async function downloadStream(
  request: DownloadRequest,
  openStage: (expectedBytes: number | undefined) => ReceivingStage,
): Promise<DownloadOutcome> {
  const input = openInput(request.url, 'hls', headersOf(request))
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  let stage: ReceivingStage | null = null
  try {
    const conversion = await Conversion.init({ input, output, tracks: 'primary' })
    if (!conversion.isValid) {
      return { type: 'failed', status: null, message: 'the stream has no track this host can copy into an MP4' }
    }
    const cancel = () => void conversion.cancel()
    request.signal.addEventListener('abort', cancel, { once: true })
    conversion.onProgress = (fraction) => request.onProgress(Math.round(fraction * PROGRESS_STEPS), PROGRESS_STEPS)
    try {
      await conversion.execute()
    } finally {
      request.signal.removeEventListener('abort', cancel)
    }
    const bytes = new Uint8Array(output.target.buffer!)
    stage = openStage(bytes.byteLength)
    for (let at = 0; at < bytes.byteLength; at += WRITE_PIECE) {
      if ((await stage.write(bytes.subarray(at, at + WRITE_PIECE))) === 'over-cap') break
    }
    return { type: 'staged', stage }
  } catch (error) {
    await stage?.discard()
    if (request.signal.aborted) return { type: 'cancelled' }
    const message = error instanceof Error ? error.message : String(error)
    const status = /\b(40[13])\b/.exec(message)?.[1]
    return status ? { type: 'refused', status: Number(status) } : { type: 'failed', status: null, message }
  } finally {
    input.dispose()
  }
}
