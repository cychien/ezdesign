import { EXTENSION_CHUNK_BYTES, STREAM_PROTOCOL, type CaptureContext, type Staged } from '../../capture-wire.js'
import { fromBase64, toBase64 } from '../shared/bytes.js'
import {
  type CaptureId,
  type CaptureView,
  DIALOG_PORT_PREFIX,
  type DialogToWorker,
  type EncodedThumb,
  type HostState,
  type Inspection,
  type PreviewSource,
  type RegionChoice,
  type Size,
  type StagingView,
} from '../shared/messages.js'
import {
  type CapturePlan,
  type TabRef,
  type Trigger,
  planAfterRefusal,
  planCapture,
  planWithoutRecording,
  posterSource,
} from '../shared/plan.js'
import type { CaptureOutcome, CaptureTimeline } from '../shared/seam.js'
import { pickSource } from '../shared/streams.js'
import {
  HostFailure,
  type BrowserOps,
  type DialogPort,
  type HostLink,
  type MediaClient,
  type PageAgent,
  type StreamObserver,
} from './ports.js'

export interface CaptureDeps {
  host: HostLink & { hold(): () => void }
  media: MediaClient
  page: PageAgent
  browser: BrowserOps
  streams: StreamObserver
  newId(): CaptureId
  onIdle(): void
  forgetAfterMs?: number
  dismissAfterMs?: number
}

export interface Captures {
  start(trigger: Trigger): Promise<CaptureId | null>
  recordProgress(id: CaptureId, seconds: number): void
  attachDialog(port: DialogPort): void
  tabClosed(tabId: number): void
  settled(id: CaptureId): Promise<CaptureOutcome>
  timeline(id: CaptureId): CaptureTimeline | null
  latest(): CaptureId | null
  busy(): boolean
}

type Staging =
  | { type: 'pending' }
  | { type: 'progress'; received: number; total: number | null }
  | { type: 'recording'; seconds: number; total: number }
  | { type: 'staged'; staged: Staged }
  | { type: 'refused'; origin: string }
  | { type: 'failed'; message: string }

interface Session {
  id: CaptureId
  plan: CapturePlan
  tab: TabRef
  frameId: number
  srcUrl: string | null
  context: CaptureContext
  timeline: CaptureTimeline
  inspection: Inspection | null
  preview: PreviewSource
  held: Uint8Array | null
  framePng: string | null
  readyThumb: EncodedThumb | null
  posterThumb: Promise<EncodedThumb | null> | null
  screenCrop: { thumb: EncodedThumb | null; png: string | null } | null
  staging: Staging
  thumbSettled: boolean
  host: HostState
  dialog: { port: DialogPort | null; where: 'page' | 'window'; windowId: number | null; nonce: string; dismissed: boolean }
  intent: { tags: string[]; note: string } | null
  committing: boolean
  finding: boolean
  offer: 'streams' | null
  background: boolean
  pill: string | null
  restaged: boolean
  cropping: Promise<void> | null
  error: string | null
  abort: AbortController
  ended: CaptureOutcome | null
  outcome: Promise<CaptureOutcome>
  resolve(outcome: CaptureOutcome): void
  release(): void
}

export const RECORD_MAX_SECONDS = 60
const PROBED_SOURCES = 12
const FORGET_AFTER_MS = 60_000
const DISMISS_AFTER_MS = 1_500
const SUGGEST_LIMIT = 8

const originOf = (url: string) => new URL(url).origin

export function createCaptures(deps: CaptureDeps): Captures {
  const sessions = new Map<CaptureId, Session>()
  let latest: CaptureId | null = null

  const setPreview = (s: Session, preview: PreviewSource) => {
    s.preview = preview
    s.dialog.port?.postMessage({ type: 'preview', preview })
  }

  const render = (s: Session) => {
    s.dialog.port?.postMessage({ type: 'view', view: viewOf(s) })
    if (!s.background) return
    const pill = pillOf(s)
    if (!pill || pill.text === s.pill) return
    s.pill = pill.text
    void deps.page.send(s.tab, 0, { to: 'page', type: 'pill', captureId: s.id, ...pill }).catch(() => {})
  }

  const toBackground = (s: Session) => {
    if (s.background || s.dialog.where !== 'page') return
    s.background = true
    dismiss(s)
    render(s)
  }

  const requestOnTimeline: HostLink['request'] = (request, options) => {
    const s = 'capture' in request ? sessions.get(request.capture as CaptureId) : undefined
    if (s && s.timeline.dialogShown === undefined) s.timeline.beforeDialog.push(request.t)
    return deps.host.request(request, options)
  }

  const dismiss = (s: Session) => {
    if (s.dialog.dismissed) return
    s.dialog.dismissed = true
    if (s.dialog.where === 'window' && s.dialog.windowId !== null) {
      void deps.browser.closeWindow(s.dialog.windowId).catch(() => {})
    } else if (s.dialog.where === 'page') {
      void deps.page.send(s.tab, 0, { to: 'page', type: 'dismiss', captureId: s.id }).catch(() => {})
    }
  }

  const end = (s: Session, outcome: CaptureOutcome) => {
    if (s.ended) return
    s.ended = outcome
    s.abort.abort()
    s.resolve(outcome)
    s.release()
    render(s)
    setTimeout(() => dismiss(s), deps.dismissAfterMs ?? DISMISS_AFTER_MS)
    setTimeout(() => sessions.delete(s.id), deps.forgetAfterMs ?? FORGET_AFTER_MS)
    if (![...sessions.values()].some((other) => !other.ended)) deps.onIdle()
  }

  const fail = (s: Session, message: string) => {
    s.staging = { type: 'failed', message }
    s.error = message
    if (s.background) return end(s, { type: 'failed', message })
    render(s)
  }

  const cancel = (s: Session) => {
    if (s.ended) return
    if (s.plan.bytes.via === 'record') {
      void deps.page.send(s.tab, s.frameId, { to: 'page', type: 'recording-drop', captureId: s.id }).catch(() => {})
    }
    if (s.staging.type !== 'refused' && s.host.type === 'ready') {
      void deps.host.request({ t: 'discard', capture: s.id }).catch(() => {})
    }
    end(s, { type: 'cancelled' })
  }

  const sendThumbnail = async (s: Session, thumb: EncodedThumb | null) => {
    if (!thumb) return
    await requestOnTimeline({
      t: 'thumbnail',
      capture: s.id,
      webp: thumb.webp,
      width: thumb.width,
      height: thumb.height,
      source: thumb.source,
    })
  }

  async function* heldPieces(bytes: Uint8Array): AsyncIterable<string> {
    yield toBase64(bytes)
  }

  const thumbnail = async (s: Session, staged: Staged): Promise<EncodedThumb | null> => {
    const staging = () => deps.host.read(s.id, { signal: s.abort.signal })
    if (s.plan.kind === 'video') {
      const poster = await s.posterThumb
      if (poster) return poster
      const decodable = staged.outcome === 'file' && s.plan.bytes.via !== 'none'
      const opening = decodable ? await deps.media.thumbnail(staging(), 'opening').catch(() => null) : null
      return opening ?? s.readyThumb ?? s.screenCrop?.thumb ?? null
    }
    if (s.readyThumb) return s.readyThumb
    if (s.plan.thumb.from === 'staged-bytes' && staged.outcome === 'file') return deps.media.thumbnail(staging())
    if (s.plan.thumb.from === 'held-bytes' && s.held) return deps.media.thumbnail(heldPieces(s.held))
    return null
  }

  const linkFrame = async (s: Session): Promise<string | null> => {
    if (s.framePng || s.screenCrop?.png) return s.framePng ?? s.screenCrop?.png ?? null
    if (s.plan.kind !== 'video' || s.dialog.where !== 'page' || !s.srcUrl) return null
    const again = await deps.page
      .send(s.tab, s.frameId, {
        to: 'page',
        type: 'inspect',
        srcUrl: s.srcUrl,
        mediaType: 'video',
        fullFrame: true,
      })
      .catch(() => null)
    const frame = again?.video?.frame
    return frame?.type === 'encoded' ? frame.png : null
  }

  const posterThumbnail = async (s: Session, url: string): Promise<EncodedThumb | null> => {
    try {
      const bytes = await deps.browser.fetchPublic(url, s.abort.signal)
      const thumb = await deps.media.thumbnail(heldPieces(bytes))
      const natural = s.inspection?.natural
      return thumb && natural ? { ...thumb, source: natural } : thumb
    } catch {
      return null
    }
  }

  /** A host that lost the capture gets it once more, from what the session still holds. */
  const restageOnce = async (s: Session): Promise<boolean> => {
    if (s.restaged) return false
    s.restaged = true
    await deps.host.state({ recheck: true })
    await stage(s)
    return true
  }

  const recordStream = async (s: Session): Promise<Uint8Array | null> => {
    if (s.held) return s.held
    if (!s.srcUrl) return null
    s.staging = { type: 'recording', seconds: 0, total: recordLength(s) }
    render(s)
    const done = await deps.page.send(s.tab, s.frameId, {
      to: 'page',
      type: 'record',
      captureId: s.id,
      srcUrl: s.srcUrl,
      maxSeconds: RECORD_MAX_SECONDS,
    })
    if (!done.ok || s.ended) return null
    const bytes = new Uint8Array(done.bytes)
    for (let offset = 0; offset < done.bytes; offset += EXTENSION_CHUNK_BYTES) {
      const { data } = await deps.page.send(s.tab, s.frameId, {
        to: 'page',
        type: 'recording-read',
        captureId: s.id,
        offset,
        length: EXTENSION_CHUNK_BYTES,
      })
      bytes.set(fromBase64(data), offset)
    }
    void deps.page.send(s.tab, s.frameId, { to: 'page', type: 'recording-drop', captureId: s.id }).catch(() => {})
    s.held = bytes
    return bytes
  }

  const stage = async (s: Session): Promise<void> => {
    await s.cropping
    s.staging = { type: 'pending' }
    s.thumbSettled = false
    render(s)
    const { bytes } = s.plan
    let staged: Staged
    try {
      if (bytes.via === 'host-download') {
        staged = await requestOnTimeline(
          {
            t: 'download',
            capture: s.id,
            kind: s.plan.kind === 'video' ? 'video' : 'image',
            url: bytes.url,
            ...(bytes.as === 'hls' ? { as: 'hls' as const } : {}),
            referer: s.tab.url ?? null,
            userAgent: deps.browser.userAgent,
            context: s.context,
          },
          {
            signal: s.abort.signal,
            onProgress: (received, total) => {
              s.staging = { type: 'progress', received, total }
              render(s)
            },
          },
        )
      } else if (bytes.via === 'record') {
        const recorded = await recordStream(s).catch(() => null)
        if (s.ended) return
        if (!recorded) {
          s.plan = planWithoutRecording(s.plan)
          return stage(s)
        }
        staged = await deps.host.upload({ capture: s.id, kind: 'video', context: s.context }, recorded, { signal: s.abort.signal })
      } else if (bytes.via === 'none') {
        const playbackTime = s.inspection?.video?.currentTime ?? null
        staged = await requestOnTimeline({ t: 'link', capture: s.id, playbackTime, context: s.context })
      } else {
        if (!s.held) throw new Error('nothing to save: the page did not hand over the bytes')
        staged = await deps.host.upload(
          { capture: s.id, kind: s.plan.kind === 'screenshot' ? 'screenshot' : 'image', context: s.context },
          s.held,
          { signal: s.abort.signal },
        )
      }
      if (staged.outcome !== 'file') {
        const png = await linkFrame(s)
        if (png) staged = await deps.host.upload({ capture: s.id, kind: 'frame', context: s.context }, fromBase64(png))
      }
    } catch (error) {
      if (s.ended) return
      const fault = error instanceof HostFailure ? error.fault : null
      if (fault?.code === 'source-refused' && s.plan.kind === 'image' && bytes.via === 'host-download') {
        s.staging = { type: 'refused', origin: originOf(bytes.url) }
        render(s)
        return
      }
      if (fault?.code === 'host-lost' && (await restageOnce(s))) return
      return fail(s, error instanceof Error ? error.message : String(error))
    }
    if (s.ended) return
    s.staging = { type: 'staged', staged }
    render(s)
    try {
      const made = await thumbnail(s, staged)
      if (made && made !== s.screenCrop?.thumb && s.preview.type === 'url' && s.preview.fromScreen) {
        setPreview(s, { type: 'url', src: `data:image/webp;base64,${made.webp}`, size: sizeOf(made) })
      }
      await sendThumbnail(s, made)
    } catch {
    }
    s.thumbSettled = true
    await maybeCommit(s)
  }

  const maybeCommit = async (s: Session): Promise<void> => {
    if (s.ended || !s.intent || s.committing || s.staging.type !== 'staged' || !s.thumbSettled) return
    s.committing = true
    s.error = null
    try {
      const result = await requestOnTimeline({ t: 'commit', capture: s.id, tags: s.intent.tags, note: s.intent.note })
      s.timeline.committed = deps.browser.now()
      end(s, { type: 'saved', itemId: result.item.id, merged: result.merged })
    } catch (error) {
      s.committing = false
      const fault = error instanceof HostFailure ? error.fault : null
      if ((fault?.code === 'unknown-capture' || fault?.code === 'host-lost') && (await restageOnce(s))) return
      s.intent = null
      s.error = error instanceof Error ? error.message : String(error)
      if (s.background) return end(s, { type: 'failed', message: s.error })
      render(s)
    }
  }

  const grant = async (s: Session, origin: string) => {
    if (s.staging.type !== 'refused' || s.staging.origin !== origin) return
    s.plan = planAfterRefusal(s.plan)
    s.staging = { type: 'pending' }
    render(s)
    const bytes = s.plan.bytes
    try {
      if (bytes.via !== 'worker-fetch') throw new Error('nothing to fetch')
      s.held = await deps.browser.fetchWithCookies(bytes.url, s.abort.signal)
    } catch (error) {
      if (!s.ended) fail(s, `讀取 ${origin} 失敗：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    await stage(s)
  }

  const onDialog = (s: Session, message: DialogToWorker) => {
    switch (message.type) {
      case 'confirm':
        if (s.ended || s.intent) return
        s.intent = { tags: message.tags, note: message.note }
        s.timeline.confirmed = deps.browser.now()
        render(s)
        if (s.plan.kind === 'video' && !(s.staging.type === 'staged' && s.thumbSettled)) toBackground(s)
        if (s.plan.bytes.via === 'record' && s.staging.type === 'pending' && !s.finding) void stage(s)
        else void maybeCommit(s)
        return
      case 'cancel':
        return cancel(s)
      case 'suggest':
        void deps.host
          .state()
          .then((state) =>
            state.type === 'ready'
              ? deps.host.request({ t: 'suggest', prefix: message.prefix, exclude: message.exclude, limit: SUGGEST_LIMIT })
              : null,
          )
          .then((reply) => reply && s.dialog.port?.postMessage({ type: 'suggestions', prefix: message.prefix, tags: reply.tags }))
          .catch(() => {})
        return
      case 'granted':
        void grant(s, message.origin)
        return
      case 'streams-granted':
        s.offer = null
        render(s)
        return
      case 'denied':
        if (s.staging.type === 'refused') fail(s, `沒有取得讀取 ${message.origin} 的權限，無法儲存這張圖片`)
        return
      case 'preview-shown':
        s.timeline.previewShown ??= message.at
        return
      case 'closed':
        return dismiss(s)
    }
  }

  async function run(s: Session, hostReady: Promise<HostState>): Promise<void> {
    const { tab } = s
    let plan = s.plan
    const inPage =
      plan.dialog === 'page' &&
      (await deps.page.ensure(tab, s.frameId)) &&
      (s.frameId === 0 || (await deps.page.ensure(tab, 0)))
    if (!inPage) s.dialog.where = 'window'

    if (plan.kind === 'screenshot') {
      const choice: RegionChoice =
        inPage && plan.region === 'drag'
          ? await deps.page.send(tab, 0, { to: 'page', type: 'select-region' })
          : { type: 'viewport', viewport: { width: 0, height: 0 }, pickedAt: deps.browser.now() }
      if (choice.type === 'cancelled') return end(s, { type: 'cancelled' })
      s.timeline.regionPicked = choice.pickedAt
      if (choice.type === 'media') {
        const picked = planCapture({
          type: 'menu',
          click: { mediaType: choice.mediaType, srcUrl: choice.srcUrl, pageUrl: tab.url, frameId: 0 },
          tab,
        })
        if (!picked) return end(s, { type: 'cancelled' })
        s.plan = plan = picked
        s.finding = picked.bytes.via === 'record'
        s.srcUrl = choice.srcUrl
        s.context.mediaUrl = /^https?:/i.test(choice.srcUrl) ? choice.srcUrl : null
      } else {
        const shot = await deps.browser.captureVisibleTab(tab.windowId, 'png')
        const rect = choice.type === 'rect' ? choice.rect : null
        setPreview(s, { type: 'screenshot', dataUrl: shot, rect, viewport: choice.viewport })
        s.cropping = deps.media.crop(shot, rect, choice.viewport, true).then((crop) => {
          s.held = crop.original && fromBase64(crop.original.png)
          s.readyThumb = crop.thumb
        })
      }
    }

    if (inPage && plan.kind !== 'screenshot' && s.srcUrl !== null) {
      s.inspection = await deps.page.send(tab, s.frameId, {
        to: 'page',
        type: 'inspect',
        srcUrl: s.srcUrl,
        mediaType: plan.kind === 'video' ? 'video' : 'image',
        fullFrame: plan.bytes.via === 'none' || plan.bytes.via === 'record',
      })
      const poster = s.inspection.video?.poster
      if (poster) s.posterThumb = posterThumbnail(s, poster)
      const grab = s.inspection.video?.frame
      if (grab?.type === 'encoded') {
        s.readyThumb = grab.thumb
        s.framePng = grab.png
      } else if (grab && posterSource(grab) === 'screenshot' && s.inspection.rect) {
        const shot = await deps.browser.captureVisibleTab(tab.windowId, 'png')
        const crop = await deps.media.crop(shot, s.inspection.rect, s.inspection.viewport, true)
        s.screenCrop = { thumb: crop.thumb, png: crop.original?.png ?? null }
      }
      if (plan.bytes.via === 'page-read') {
        const read = await deps.page.send(tab, s.frameId, { to: 'page', type: 'read', url: plan.bytes.url })
        s.held = read.data === null ? null : fromBase64(read.data)
      }
    }

    const fallback = fallbackPreview(s)
    if (plan.kind !== 'screenshot') {
      s.preview =
        inPage && plan.preview === 'element-bitmap' && s.inspection?.found
          ? { type: 'bitmap', nonce: s.dialog.nonce, size: s.inspection.natural }
          : fallback
    }

    if (inPage) {
      const { mounted, handedOff } = await deps.page.send(tab, 0, {
        to: 'page',
        type: 'present',
        captureId: s.id,
        dialogPath: deps.browser.dialogPath(s.id),
        nonce: s.dialog.nonce,
        bitmap: s.preview.type === 'bitmap',
      })
      if (!mounted) throw new Error('the dialog could not be shown on this page')
      if (s.preview.type === 'bitmap' && !handedOff) {
        setPreview(s, fallback)
      }
    } else {
      s.dialog.windowId = await deps.browser.openDialogWindow(s.id)
    }
    s.timeline.dialogShown = deps.browser.now()

    const host = await hostReady
    if (s.ended || host.type !== 'ready') {
      s.finding = false
      return render(s)
    }
    if (s.plan.bytes.via === 'record') {
      if (host.protocol < STREAM_PROTOCOL) {
        s.finding = false
        s.plan = planWithoutRecording(s.plan)
      } else await findOriginal(s)
      if (s.ended) return
      if (s.plan.bytes.via === 'record') {
        render(s)
        if (s.intent) await stage(s)
        return
      }
    }
    await stage(s)
  }

  async function findOriginal(s: Session): Promise<void> {
    try {
      const original = await deps.page.originalOf(s.tab, s.frameId).catch(() => null)
      if (original) return downloadFrom(s, original, 'file')
      if (!(await deps.streams.granted())) {
        s.offer = 'streams'
        return
      }
      const sources = (await deps.streams.sourcesFor(s.tab.id)).slice(0, PROBED_SOURCES)
      if (!sources.length) return
      const probed = await requestOnTimeline({
        t: 'probe',
        sources: sources.map(({ url, as }) => ({ url, as })),
        referer: s.tab.url ?? null,
        userAgent: deps.browser.userAgent,
      }).catch(() => ({ durations: [], masters: [] }))
      const picked = pickSource(sources, probed, s.inspection?.video?.duration ?? null)
      if (picked) downloadFrom(s, picked.url, picked.as)
    } finally {
      s.finding = false
      render(s)
    }
  }

  function downloadFrom(s: Session, url: string, as: 'file' | 'hls'): void {
    s.plan = { ...s.plan, bytes: { via: 'host-download', url, as } }
    s.context.mediaUrl = url
  }

  async function start(trigger: Trigger): Promise<CaptureId | null> {
    const plan = planCapture(trigger)
    if (!plan) return null
    const id = deps.newId()
    const click = trigger.type === 'menu' ? trigger.click : null
    let resolve: (outcome: CaptureOutcome) => void = () => {}
    const outcome = new Promise<CaptureOutcome>((r) => (resolve = r))
    const s: Session = {
      id,
      plan,
      tab: trigger.tab,
      frameId: click?.frameId ?? 0,
      srcUrl: click?.srcUrl ?? null,
      context: {
        pageUrl: click?.pageUrl ?? trigger.tab.url ?? '',
        pageTitle: trigger.tab.title ?? '',
        mediaUrl: click?.srcUrl && /^https?:/i.test(click.srcUrl) ? click.srcUrl : null,
        capturedAt: Date.now(),
      },
      timeline: { triggered: deps.browser.now(), beforeDialog: [] },
      inspection: null,
      preview: { type: 'none' },
      held: null,
      framePng: null,
      readyThumb: null,
      posterThumb: null,
      screenCrop: null,
      staging: { type: 'pending' },
      thumbSettled: false,
      host: { type: 'connecting' },
      dialog: { port: null, where: plan.dialog, windowId: null, nonce: id, dismissed: false },
      intent: null,
      committing: false,
      finding: plan.bytes.via === 'record',
      offer: null,
      background: false,
      pill: null,
      restaged: false,
      cropping: null,
      error: null,
      abort: new AbortController(),
      ended: null,
      outcome,
      resolve,
      release: deps.host.hold(),
    }
    sessions.set(id, s)
    latest = id
    const hostReady = deps.host.state().then((state) => {
      s.host = state
      render(s)
      return state
    })
    void deps.media.warm().catch(() => {})
    void run(s, hostReady).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      s.error = message
      end(s, { type: 'failed', message })
    })
    return id
  }

  return {
    start,
    recordProgress(id, seconds) {
      const s = sessions.get(id)
      if (s?.staging.type !== 'recording') return
      s.staging = { ...s.staging, seconds }
      render(s)
    },
    attachDialog(port) {
      const s = sessions.get(port.name.slice(DIALOG_PORT_PREFIX.length) as CaptureId)
      if (!port.name.startsWith(DIALOG_PORT_PREFIX) || !s || s.ended) {
        port.disconnect()
        return
      }
      s.dialog.port = port
      port.onMessage.addListener((message) => onDialog(s, message))
      port.onDisconnect.addListener(() => {
        s.dialog.port = null
        if (s.ended) dismiss(s)
        else if (!s.background) cancel(s)
      })
      port.postMessage({ type: 'preview', preview: s.preview })
      render(s)
    },
    tabClosed(tabId) {
      for (const s of sessions.values()) if (s.tab.id === tabId && s.dialog.where === 'page') cancel(s)
    },
    settled(id) {
      return sessions.get(id)?.outcome ?? Promise.resolve({ type: 'failed', message: `no capture ${id}` })
    },
    timeline(id) {
      return sessions.get(id)?.timeline ?? null
    },
    latest() {
      return latest
    },
    busy() {
      return [...sessions.values()].some((s) => !s.ended)
    },
  }
}

const sizeOf = (thumb: EncodedThumb): Size => ({ width: thumb.width, height: thumb.height })

function pillOf(s: Session): { text: string; tone: 'working' | 'done' | 'error' } | null {
  if (s.ended?.type === 'saved') return { text: '已儲存', tone: 'done' }
  if (s.ended?.type === 'failed') return { text: '影片沒有存成功', tone: 'error' }
  if (s.ended) return null
  if (s.staging.type === 'recording') {
    return { text: `正在錄製影片 ${Math.floor(s.staging.seconds)} / ${Math.round(s.staging.total)} 秒`, tone: 'working' }
  }
  if (s.staging.type === 'progress' && s.staging.total) {
    return { text: `影片處理中 ${Math.min(99, Math.floor((s.staging.received / s.staging.total) * 100))}%`, tone: 'working' }
  }
  return { text: '影片處理中…', tone: 'working' }
}

function recordLength(s: Session): number {
  return Math.min(RECORD_MAX_SECONDS, s.inspection?.video?.duration ?? RECORD_MAX_SECONDS)
}

function fallbackPreview(s: Session): PreviewSource {
  const natural = s.inspection?.natural ?? null
  if (s.plan.kind === 'image' && s.context.mediaUrl) return { type: 'url', src: s.context.mediaUrl, size: natural }
  if (s.framePng) return { type: 'url', src: `data:image/png;base64,${s.framePng}`, size: natural }
  if (s.readyThumb) return { type: 'url', src: `data:image/webp;base64,${s.readyThumb.webp}`, size: sizeOf(s.readyThumb) }
  if (s.screenCrop?.png) {
    return { type: 'url', src: `data:image/png;base64,${s.screenCrop.png}`, fromScreen: true, size: s.screenCrop.thumb && sizeOf(s.screenCrop.thumb) }
  }
  return { type: 'none' }
}

function stagingView(staging: Staging): StagingView {
  switch (staging.type) {
    case 'pending':
    case 'progress':
    case 'recording':
    case 'failed':
      return staging
    case 'staged':
      return { type: 'staged', bytes: staging.staged.bytes }
    case 'refused':
      return { type: 'needs-permission', origin: staging.origin }
  }
}

export function viewOf(s: Session): CaptureView {
  const staged = s.staging.type === 'staged' ? s.staging.staged : null
  const blocked = s.host.type !== 'ready' || s.staging.type === 'failed' || s.staging.type === 'refused'
  const confirm: CaptureView['confirm'] =
    s.ended?.type === 'saved'
      ? 'saved'
      : s.ended
        ? 'disabled'
        : s.intent
          ? 'saving'
          : blocked
            ? 'disabled'
            : 'enabled'
  return {
    captureId: s.id,
    kind: s.plan.kind,
    page: { url: s.context.pageUrl, title: s.context.pageTitle },
    host: s.host,
    staging: stagingView(s.staging),
    duplicate: staged?.duplicate ? { tags: staged.duplicate.tags, note: staged.duplicate.note } : null,
    notice:
      s.plan.bytes.via === 'record'
        ? 'record'
        : s.plan.bytes.via === 'none' || staged?.outcome === 'stream-link'
          ? 'stream-link'
          : staged?.outcome === 'too-large'
            ? 'too-large'
            : null,
    recordSeconds: s.plan.bytes.via === 'record' ? Math.round(recordLength(s)) : null,
    finding: s.finding,
    offer: s.offer,
    confirm,
    error: s.error,
  }
}
