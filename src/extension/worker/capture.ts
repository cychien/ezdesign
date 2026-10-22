import type { CaptureContext, Staged } from '../../capture-wire.js'
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
  type StagingView,
} from '../shared/messages.js'
import { type CapturePlan, type TabRef, type Trigger, planAfterRefusal, planCapture, posterSource } from '../shared/plan.js'
import type { CaptureOutcome, CaptureTimeline } from '../shared/seam.js'
import { HostFailure, type BrowserOps, type DialogPort, type HostLink, type MediaClient, type PageAgent } from './ports.js'

export interface CaptureDeps {
  host: HostLink & { hold(): () => void }
  media: MediaClient
  page: PageAgent
  browser: BrowserOps
  newId(): CaptureId
  onIdle(): void
  forgetAfterMs?: number
  dismissAfterMs?: number
}

export interface Captures {
  start(trigger: Trigger): Promise<CaptureId | null>
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
  screenCrop: { thumb: EncodedThumb | null; png: string | null } | null
  staging: Staging
  thumbSettled: boolean
  host: HostState
  dialog: { port: DialogPort | null; where: 'page' | 'window'; windowId: number | null; nonce: string; dismissed: boolean }
  intent: { tags: string[]; note: string } | null
  committing: boolean
  restaged: boolean
  cropping: Promise<void> | null
  error: string | null
  abort: AbortController
  ended: CaptureOutcome | null
  outcome: Promise<CaptureOutcome>
  resolve(outcome: CaptureOutcome): void
  release(): void
}

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

  const render = (s: Session) => s.dialog.port?.postMessage({ type: 'view', view: viewOf(s) })

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
    render(s)
  }

  const cancel = (s: Session) => {
    if (s.ended) return
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
    if (s.readyThumb) return s.readyThumb
    const staging = () => deps.host.read(s.id, { signal: s.abort.signal })
    if (s.plan.kind === 'video') {
      const at = s.inspection?.video?.currentTime
      const decoded = staged.outcome === 'file' && at !== undefined ? await deps.media.thumbnail(staging(), at) : null
      return decoded ?? s.screenCrop?.thumb ?? null
    }
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

  /** A host that lost the capture gets it once more, from what the session still holds. */
  const restageOnce = async (s: Session): Promise<boolean> => {
    if (s.restaged) return false
    s.restaged = true
    await deps.host.state({ recheck: true })
    await stage(s)
    return true
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
        setPreview(s, { type: 'url', src: `data:image/webp;base64,${made.webp}` })
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
        void maybeCommit(s)
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
    const { plan, tab } = s
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
      const shot = await deps.browser.captureVisibleTab(tab.windowId, 'png')
      const rect = choice.type === 'rect' ? choice.rect : null
      setPreview(s, { type: 'screenshot', dataUrl: shot, rect, viewport: choice.viewport })
      s.cropping = deps.media.crop(shot, rect, choice.viewport, true).then((crop) => {
        s.held = crop.original && fromBase64(crop.original.png)
        s.readyThumb = crop.thumb
      })
    }

    if (inPage && plan.kind !== 'screenshot' && s.srcUrl !== null) {
      s.inspection = await deps.page.send(tab, s.frameId, {
        to: 'page',
        type: 'inspect',
        srcUrl: s.srcUrl,
        mediaType: plan.kind === 'video' ? 'video' : 'image',
        fullFrame: plan.bytes.via === 'none',
      })
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
        inPage && plan.preview === 'element-bitmap' && s.inspection?.found ? { type: 'bitmap', nonce: s.dialog.nonce } : fallback
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
    if (s.ended || host.type !== 'ready') return
    await stage(s)
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
      screenCrop: null,
      staging: { type: 'pending' },
      thumbSettled: false,
      host: { type: 'connecting' },
      dialog: { port: null, where: plan.dialog, windowId: null, nonce: id, dismissed: false },
      intent: null,
      committing: false,
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
        else cancel(s)
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

function fallbackPreview(s: Session): PreviewSource {
  if (s.plan.kind === 'image' && s.context.mediaUrl) return { type: 'url', src: s.context.mediaUrl }
  if (s.framePng) return { type: 'url', src: `data:image/png;base64,${s.framePng}` }
  if (s.readyThumb) return { type: 'url', src: `data:image/webp;base64,${s.readyThumb.webp}` }
  if (s.screenCrop?.png) return { type: 'url', src: `data:image/png;base64,${s.screenCrop.png}`, fromScreen: true }
  return { type: 'none' }
}

function stagingView(staging: Staging): StagingView {
  switch (staging.type) {
    case 'pending':
    case 'progress':
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
      s.plan.bytes.via === 'none' || staged?.outcome === 'stream-link'
        ? 'stream-link'
        : staged?.outcome === 'too-large'
          ? 'too-large'
          : null,
    confirm,
    error: s.error,
  }
}
