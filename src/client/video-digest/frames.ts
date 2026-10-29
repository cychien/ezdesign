import { Input, MATROSKA, MP4, QTFF, UrlSource, type VideoSample, VideoSampleSink, WEBM } from 'mediabunny'
import type { DigestFailure, VideoRect } from '../../protocol.js'

const READ_CACHE_BYTES = 32 * 1024 * 1024

const FORMATS = [MP4, QTFF, WEBM, MATROSKA]

function openInput(url: string): Input<UrlSource> {
  return new Input({ formats: FORMATS, source: new UrlSource(url, { maxCacheSize: READ_CACHE_BYTES }) })
}

export interface FrameSource {
  readonly width: number
  readonly height: number
  readonly durationUs: number
  readonly audio: boolean
  all(): AsyncIterable<Frame>
  at(timestamps: readonly number[]): AsyncIterable<Frame>
  close(): void
}

export interface Frame {
  readonly t: number
  draw(ctx: OffscreenCanvasRenderingContext2D, src: VideoRect, dst: VideoRect): void
  /** At once, after drawing: a hardware decoder has only a handful of frames to
   *  lend, and holding them stalls it. */
  close(): void
}

export type Opened = { ok: FrameSource } | { failed: DigestFailure; detail: string }

export async function openFrames(url: string): Promise<Opened> {
  const input = openInput(url)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) {
      input.dispose()
      return { failed: 'unreadable', detail: 'no video track' }
    }
    if (!(await track.canDecode())) {
      input.dispose()
      return { failed: 'unsupported-codec', detail: track.codec ?? 'unknown codec' }
    }
    const [first, duration, audio] = await Promise.all([
      track.getFirstTimestamp(),
      input.computeDuration(),
      input.getAudioTracks(),
    ])
    const sink = new VideoSampleSink(track)
    return {
      ok: {
        width: track.displayWidth,
        height: track.displayHeight,
        durationUs: Math.round((duration - first) * 1e6),
        audio: audio.length > 0,
        all: () => every(sink, first),
        at: (timestamps) => exactly(sink, first, timestamps),
        close: () => input.dispose(),
      },
    }
  } catch (error) {
    input.dispose()
    return { failed: 'unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
}

function wrap(sample: VideoSample, t: number): Frame {
  return {
    t,
    draw: (ctx, src, dst) =>
      sample.draw(ctx, src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height),
    close: () => sample.close(),
  }
}

async function* every(sink: VideoSampleSink, firstSeconds: number): AsyncIterable<Frame> {
  for await (const sample of sink.samples()) {
    yield wrap(sample, Math.round((sample.timestamp - firstSeconds) * 1e6))
  }
}

/** Asked a microsecond past each frame's own time, so rounding can never land on
 *  the frame before it; reported at the time asked for, so callers match it. */
async function* exactly(sink: VideoSampleSink, firstSeconds: number, timestamps: readonly number[]): AsyncIterable<Frame> {
  const seconds = timestamps.map((t) => firstSeconds + (t + 1) / 1e6)
  let i = 0
  for await (const sample of sink.samplesAtTimestamps(seconds)) {
    const t = timestamps[i++]!
    if (sample) yield wrap(sample, t)
  }
}
