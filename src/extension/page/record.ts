import { toBase64 } from '../shared/bytes.js'
import type { CaptureId, PageReplies, WorkerRequest } from '../shared/messages.js'
import { findMedia } from './locate.js'

const TARGET_BYTES = 40 * 1024 * 1024
const MAX_BITRATE = 8_000_000
const PROGRESS_EVERY_MS = 500
/** A video that stops moving for this long while its tab is on screen - the
 *  page paused it, the network stalled - is not going to finish. A hidden tab
 *  does not count: Chrome pauses video there, and it resumes on return. */
const STALL_MS = 10_000
const SEEK_TIMEOUT_MS = 5_000
const TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

type Recording = { state: 'running'; stop(): void } | { state: 'done'; blob: Blob }

const recordings = new Map<CaptureId, Recording>()

type Capturable = HTMLVideoElement & { captureStream?: () => MediaStream }

const CHECK_EVERY_MS = 100

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const once = (target: EventTarget, event: string, ms: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    target.addEventListener(event, () => (clearTimeout(timer), resolve(true)), { once: true })
  })

export async function recordVideo(captureId: CaptureId, srcUrl: string, maxSeconds: number): Promise<PageReplies['record']> {
  const video = findMedia(srcUrl, 'video') as Capturable | null
  if (!(video instanceof HTMLVideoElement)) return { ok: false, reason: 'the video is no longer on the page' }
  if (video.mediaKeys) return { ok: false, reason: 'the video is protected' }
  const mimeType = TYPES.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t))
  if (!mimeType || !video.captureStream) return { ok: false, reason: 'this browser cannot record a video' }

  const length = Math.min(maxSeconds, Number.isFinite(video.duration) ? video.duration : maxSeconds)
  const before = { time: video.currentTime, paused: video.paused, loop: video.loop, rate: video.playbackRate }
  let stream: MediaStream
  try {
    stream = video.captureStream()
  } catch (error) {
    return { ok: false, reason: (error as DOMException).name === 'SecurityError' ? 'the video is from another site' : String(error) }
  }

  const restore = () => {
    video.loop = before.loop
    video.playbackRate = before.rate
    video.currentTime = before.time
    if (before.paused) video.pause()
    else void video.play().catch(() => {})
  }

  video.pause()
  video.loop = false
  video.playbackRate = 1
  if (video.currentTime !== 0) {
    video.currentTime = 0
    await once(video, 'seeked', SEEK_TIMEOUT_MS)
  }
  const played = await Promise.race([
    video.play().then(
      () => true,
      () => false,
    ),
    wait(SEEK_TIMEOUT_MS).then(() => false),
  ])
  if (played && !stream.getVideoTracks().length) await once(stream, 'addtrack', SEEK_TIMEOUT_MS)
  const track = stream.getVideoTracks()[0]
  if (!played || !track) {
    restore()
    return { ok: false, reason: 'the video would not play' }
  }

  const recorder = new MediaRecorder(new MediaStream([track]), {
    mimeType,
    videoBitsPerSecond: Math.min(MAX_BITRATE, Math.floor((TARGET_BYTES * 8) / Math.max(1, length))),
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }

  const finished = new Promise<'done' | 'stalled' | 'dropped'>((resolve) => {
    let lastTime = -1
    let lastMove = performance.now()
    let lastPost = 0
    const tick = setInterval(() => {
      const now = performance.now()
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime
        lastMove = now
      }
      if (document.hidden) lastMove = now
      if (now - lastPost >= PROGRESS_EVERY_MS) {
        lastPost = now
        const progress: WorkerRequest = { to: 'worker', type: 'record-progress', captureId, seconds: Math.min(length, lastTime) }
        void chrome.runtime.sendMessage(progress).catch(() => {})
      }
      if (video.ended || video.currentTime >= length - 0.02) settle('done')
      else if (now - lastMove > STALL_MS) settle('stalled')
    }, CHECK_EVERY_MS)
    const onEnded = () => settle('done')
    const onReturn = () => {
      if (document.hidden) {
        if (recorder.state === 'recording') recorder.pause()
        return
      }
      if (video.paused && !video.ended) void video.play().catch(() => {})
      if (recorder.state === 'paused') recorder.resume()
    }
    video.addEventListener('ended', onEnded)
    document.addEventListener('visibilitychange', onReturn)
    const settle = (how: 'done' | 'stalled' | 'dropped') => {
      clearInterval(tick)
      video.removeEventListener('ended', onEnded)
      document.removeEventListener('visibilitychange', onReturn)
      resolve(how)
    }
    recordings.set(captureId, { state: 'running', stop: () => settle('dropped') })
  })

  recorder.start(1000)
  const how = await finished
  const stopped = once(recorder, 'stop', SEEK_TIMEOUT_MS)
  recorder.stop()
  await stopped
  track.stop()
  restore()
  if (how !== 'done') {
    recordings.delete(captureId)
    return { ok: false, reason: how === 'stalled' ? 'the video stopped playing' : 'the recording was called off' }
  }
  const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
  recordings.set(captureId, { state: 'done', blob })
  return { ok: true, bytes: blob.size }
}

export async function readRecording(captureId: CaptureId, offset: number, length: number): Promise<PageReplies['recording-read']> {
  const recording = recordings.get(captureId)
  if (recording?.state !== 'done') throw new Error('no finished recording')
  return { data: toBase64(new Uint8Array(await recording.blob.slice(offset, offset + length).arrayBuffer())) }
}

export function dropRecording(captureId: CaptureId): void {
  const recording = recordings.get(captureId)
  if (recording?.state === 'running') recording.stop()
  recordings.delete(captureId)
}
