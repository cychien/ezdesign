import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Staged } from '../src/capture-wire.js'
import type { CaptureId, DialogToWorker, HostState, PageCommand, RegionChoice, WorkerToDialog } from '../src/extension/shared/messages.js'
import type { StreamSource } from '../src/extension/shared/streams.js'
import { createCaptures } from '../src/extension/worker/capture.js'
import { type DialogPort, HostFailure, type HostLink } from '../src/extension/worker/ports.js'

const READY: HostState = { type: 'ready', version: 'test', node: 'v24', libraryDir: '/lib', protocol: 2 }
const tab = { id: 7, windowId: 1, url: 'https://site.test/board', title: 'Board' }
const thumb = { webp: 'UklGRg==', width: 4, height: 3, source: { width: 40, height: 30 } }
const POSTER = new Uint8Array([9, 9, 9])
const POSTER_B64 = Buffer.from(POSTER).toString('base64')
const openingThumb = { webp: 'T1BFTklORw==', width: 400, height: 225, source: { width: 1280, height: 720 } }
const posterThumb = { webp: 'UE9TVEVS', width: 400, height: 225, source: { width: 1280, height: 720 } }
const file = (bytes = 10): Staged => ({ outcome: 'file', bytes, mediaType: 'image/png', duplicate: null })

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function later<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Answer = (request: Record<string, unknown>) => Promise<unknown> | unknown

function world(
  options: {
    state?: HostState
    answers?: Record<string, Answer>
    mounted?: boolean
    region?: RegionChoice
    injects?: boolean
    record?: () => Promise<{ ok: true; bytes: number } | { ok: false; reason: string }>
    original?: string | null
    streams?: { granted: boolean; sources: StreamSource[] }
    poster?: string | null
    posterFetch?: () => Promise<Uint8Array>
  } = {},
) {
  const sent: Record<string, unknown>[] = []
  const pageCommands: PageCommand['type'][] = []
  const pills: string[] = []
  const answers: Record<string, Answer> = {
    download: () => file(),
    upload: () => ({}),
    'upload-end': () => file(),
    link: () => ({ outcome: 'stream-link', bytes: null, mediaType: null, duplicate: null }),
    thumbnail: () => ({}),
    commit: (r) => ({ item: { id: `item-${String(r.capture)}`, tags: r.tags, note: r.note, hasThumbnail: true }, merged: false }),
    discard: () => ({}),
    suggest: () => ({ tags: [{ name: 'card', uses: 3 }] }),
    probe: (r) => ({ durations: (r.sources as unknown[]).map(() => 20.4), masters: (r.sources as unknown[]).map(() => false) }),
    ...options.answers,
  }
  let state = options.state ?? READY
  const host: HostLink & { hold(): () => void } = {
    state: async () => state,
    async request(request) {
      sent.push(request)
      return (await answers[request.t]!(request)) as never
    },
    async upload(input, bytes) {
      sent.push({ t: 'upload', ...input, size: bytes.length })
      return answers['upload-end']!({ capture: input.capture }) as Staged
    },
    async *read() {
      sent.push({ t: 'read' })
      yield 'AAAA'
    },
    onLost: () => () => {},
    hold: () => () => {},
  }
  let n = 0
  let shots = 0
  const windows: number[] = []
  const dismissed: string[] = []
  const captures = createCaptures({
    host,
    media: {
      warm: async () => {},
      thumbnail: async (pieces, at) => {
        let first = ''
        for await (const piece of pieces) first ||= piece
        return first === POSTER_B64 ? posterThumb : at === 'opening' ? openingThumb : thumb
      },
      crop: async () => ({ original: { png: 'iVBORw0KGgo=', size: { width: 200, height: 100 } }, thumb }),
    },
    streams: {
      granted: async () => options.streams?.granted ?? false,
      sourcesFor: async () => options.streams?.sources ?? [],
    },
    page: {
      ensure: async () => options.injects ?? true,
      originalOf: async () => options.original ?? null,
      async send(_tab, _frame, command) {
        pageCommands.push(command.type)
        if (command.type === 'inspect') {
          return { found: true, viewport: { width: 800, height: 600 }, rect: null, natural: { width: 40, height: 30 }, video: command.mediaType === 'video' ? { currentTime: 3.5, duration: 20.4, poster: options.poster ?? null, frame: { type: 'encoded', thumb, png: 'iVBORw0KGgo=' } } : null } as never
        }
        if (command.type === 'record') return (await (options.record?.() ?? { ok: true, bytes: 4 })) as never
        if (command.type === 'recording-read') {
          return { data: Buffer.from([1, 2, 3, 4]).subarray(command.offset, command.offset + command.length).toString('base64') } as never
        }
        if (command.type === 'select-region') {
          return (options.region ?? { type: 'rect', rect: { x: 10, y: 20, width: 100, height: 50 }, viewport: { width: 800, height: 600 }, pickedAt: 0.5 }) as never
        }
        if (command.type === 'present') return { mounted: options.mounted ?? true, handedOff: true } as never
        if (command.type === 'dismiss') dismissed.push(command.captureId)
        if (command.type === 'pill') pills.push(`${command.tone}:${command.text}`)
        return {} as never
      },
    },
    browser: {
      captureVisibleTab: async () => {
        shots++
        return 'data:image/png;base64,SHOT'
      },
      dialogPath: (id) => `dialog.html#${id}`,
      openDialogWindow: async () => {
        windows.push(1)
        return 1
      },
      closeWindow: async () => {},
      fetchWithCookies: async () => new Uint8Array([1, 2, 3]),
      fetchPublic: async () => (options.posterFetch ?? (async () => POSTER))(),
      userAgent: 'test',
      now: () => ++n,
    },
    newId: () => `cap_${n}_0000000` as CaptureId,
    onIdle: () => {},
    dismissAfterMs: 0,
    forgetAfterMs: 200,
  })

  const dialog = (id: CaptureId) => {
    const seen: WorkerToDialog[] = []
    const listeners: ((m: DialogToWorker) => void)[] = []
    const gone: (() => void)[] = []
    const port: DialogPort = {
      name: `dialog:${id}`,
      postMessage: (m) => seen.push(m),
      disconnect: () => {},
      onMessage: { addListener: (l) => listeners.push(l) },
      onDisconnect: { addListener: (l) => gone.push(l) },
    }
    captures.attachDialog(port)
    return {
      seen,
      view: () => [...seen].reverse().find((m) => m.type === 'view')?.view,
      say: (m: DialogToWorker) => listeners.forEach((l) => l(m)),
      close: () => gone.forEach((l) => l()),
    }
  }

  const menu = (srcUrl: string, mediaType: 'image' | 'video' = 'image') =>
    captures.start({ type: 'menu', click: { mediaType, srcUrl, pageUrl: tab.url, frameId: 0 }, tab })

  const region = (url = tab.url) => captures.start({ type: 'region', tab: { ...tab, url } })

  return {
    captures,
    sent,
    pageCommands,
    pills,
    dismissed,
    dialog,
    menu,
    region,
    shots: () => shots,
    windows,
    setState: (s: HostState) => (state = s),
  }
}

const types = (sent: Record<string, unknown>[]) => sent.map((r) => r.t)

test('a confirm before staging finishes is kept, and commits once the stage and thumbnail settle', async () => {
  const download = later<Staged>()
  const w = world({ answers: { download: () => download.promise } })
  const id = (await w.menu('https://cdn.test/a.png'))!
  const d = w.dialog(id)
  await flush()
  d.say({ type: 'confirm', tags: ['hero'], note: '好看' })
  await flush()
  assert.equal(d.view()?.confirm, 'saving')
  assert.deepEqual(types(w.sent), ['download'])
  download.resolve(file(5))
  assert.deepEqual(await w.captures.settled(id), { type: 'saved', itemId: `item-${id}`, merged: false })
  assert.deepEqual(types(w.sent), ['download', 'read', 'thumbnail', 'commit'])
  assert.deepEqual(w.sent.at(-1), { t: 'commit', capture: id, tags: ['hero'], note: '好看' })
  assert.deepEqual(w.captures.timeline(id)?.beforeDialog, [])
  assert.deepEqual(w.pageCommands.slice(0, 2), ['inspect', 'present'])
})

test('cancel while the download runs discards it and saves nothing', async () => {
  const download = later<Staged>()
  const w = world({ answers: { download: () => download.promise } })
  const id = (await w.menu('https://cdn.test/a.png'))!
  const d = w.dialog(id)
  await flush()
  d.say({ type: 'cancel' })
  assert.deepEqual(await w.captures.settled(id), { type: 'cancelled' })
  assert.deepEqual(types(w.sent), ['download', 'discard'])
  download.resolve(file())
  await flush()
  assert.deepEqual(types(w.sent), ['download', 'discard'], 'a stage that lands after the cancel is not committed')
  d.say({ type: 'closed' })
  await flush()
  assert.deepEqual(w.dismissed, [id])
})

test('a dialog that goes away mid-capture cancels it', async () => {
  const w = world()
  const id = (await w.menu('https://cdn.test/a.png'))!
  const d = w.dialog(id)
  await flush()
  d.close()
  assert.deepEqual(await w.captures.settled(id), { type: 'cancelled' })
})

test('a host that lost the capture is staged again once, then the commit goes through', async () => {
  let commits = 0
  const w = world({
    answers: {
      commit: (r) => {
        commits++
        if (commits === 1) throw new HostFailure({ code: 'unknown-capture', message: 'the host restarted' })
        return { item: { id: 'item-1', tags: r.tags, note: '', hasThumbnail: true }, merged: false }
      },
    },
  })
  const id = (await w.menu('https://cdn.test/a.png'))!
  const d = w.dialog(id)
  await flush()
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.deepEqual(await w.captures.settled(id), { type: 'saved', itemId: 'item-1', merged: false })
  assert.deepEqual(types(w.sent), ['download', 'read', 'thumbnail', 'commit', 'download', 'read', 'thumbnail', 'commit'])
})

test('a source the host is refused for waits for the grant, then is fetched with cookies', async () => {
  const w = world({
    answers: {
      download: () => {
        throw new HostFailure({ code: 'source-refused', message: 'the source answered 403', status: 403 })
      },
    },
  })
  const id = (await w.menu('https://private.test/p.png'))!
  const d = w.dialog(id)
  await flush()
  await flush()
  assert.deepEqual(d.view()?.staging, { type: 'needs-permission', origin: 'https://private.test' })
  assert.equal(d.view()?.confirm, 'disabled')
  d.say({ type: 'granted', origin: 'https://private.test' })
  await flush()
  await flush()
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.deepEqual(types(w.sent), ['download', 'upload', 'thumbnail', 'commit'])
  assert.equal(w.sent[1]!.kind, 'image')
})

test('a denied grant keeps 儲存 disabled and says why', async () => {
  const w = world({
    answers: {
      download: () => {
        throw new HostFailure({ code: 'source-refused', message: '403', status: 403 })
      },
    },
  })
  const id = (await w.menu('https://private.test/p.png'))!
  const d = w.dialog(id)
  await flush()
  await flush()
  d.say({ type: 'denied', origin: 'https://private.test' })
  assert.equal(d.view()?.confirm, 'disabled')
  assert.match(d.view()?.error ?? '', /沒有取得讀取 https:\/\/private\.test 的權限/)
})

test('with no host the dialog shows the install command and nothing is staged', async () => {
  const missing: HostState = { type: 'missing', installCommand: 'npx -y @cychien/ezdesign@latest extension install' }
  const w = world({ state: missing })
  const id = (await w.menu('https://cdn.test/a.png'))!
  const d = w.dialog(id)
  await flush()
  assert.deepEqual(d.view()?.host, missing)
  assert.equal(d.view()?.confirm, 'disabled')
  d.say({ type: 'confirm', tags: [], note: '' })
  d.say({ type: 'cancel' })
  assert.deepEqual(await w.captures.settled(id), { type: 'cancelled' })
  assert.deepEqual(w.sent, [])
})

test('on a host older than protocol 2, a stream saves as a link with its time and the full-size frame', async () => {
  const w = world({ state: { ...READY, protocol: 1 } })
  const id = (await w.menu('blob:https://site.test/6f1c', 'video'))!
  const d = w.dialog(id)
  await flush()
  assert.equal(d.view()?.notice, 'stream-link')
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.deepEqual(types(w.sent), ['link', 'upload', 'thumbnail', 'commit'])
  assert.equal(w.sent[0]!.playbackTime, 3.5)
  assert.equal((w.sent[0]!.context as { mediaUrl: unknown }).mediaUrl, null)
  assert.equal(w.sent[1]!.kind, 'frame')
  assert.ok(!w.pageCommands.includes('record'))
})

test('a stream is recorded only once 儲存 is pressed, with its progress shown, then saved as a video', async () => {
  const recording = later<{ ok: true; bytes: number }>()
  const w = world({ record: () => recording.promise })
  const id = (await w.menu('blob:https://site.test/6f1c', 'video'))!
  const d = w.dialog(id)
  await flush()
  assert.equal(d.view()?.notice, 'record')
  assert.equal(d.view()?.recordSeconds, 20)
  assert.equal(d.view()?.confirm, 'enabled')
  assert.ok(!w.pageCommands.includes('record'), 'nothing is recorded before the user asks')
  assert.equal(w.sent.length, 0)

  d.say({ type: 'confirm', tags: ['motion'], note: '' })
  await flush()
  assert.ok(w.pageCommands.includes('record'))
  w.captures.recordProgress(id, 7.5)
  assert.deepEqual(d.view()?.staging, { type: 'recording', seconds: 7.5, total: 20.4 })
  recording.resolve({ ok: true, bytes: 4 })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.deepEqual(types(w.sent), ['upload', 'read', 'thumbnail', 'commit'], 'the thumbnail is the recording\'s opening')
  assert.deepEqual([w.sent[0]!.kind, w.sent[0]!.size], ['video', 4])
  assert.deepEqual(w.sent[3]!.tags, ['motion'])
  assert.ok(w.pageCommands.includes('recording-read') && w.pageCommands.includes('recording-drop'))
})

test('a stream the page cannot record is saved as a link with its frame instead', async () => {
  const w = world({ record: async () => ({ ok: false, reason: 'the video is protected' }) })
  const id = (await w.menu('blob:https://site.test/6f1c', 'video'))!
  const d = w.dialog(id)
  await flush()
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.deepEqual(types(w.sent), ['link', 'upload', 'thumbnail', 'commit'])
  assert.equal(w.sent[1]!.kind, 'frame')
})

test('cancelling while a stream records stops the recording and saves nothing', async () => {
  const recording = later<{ ok: true; bytes: number }>()
  const w = world({ record: () => recording.promise })
  const id = (await w.menu('blob:https://site.test/6f1c', 'video'))!
  const d = w.dialog(id)
  await flush()
  d.say({ type: 'confirm', tags: [], note: '' })
  await flush()
  d.say({ type: 'cancel' })
  assert.deepEqual(await w.captures.settled(id), { type: 'cancelled' })
  assert.ok(w.pageCommands.includes('recording-drop'))
  recording.resolve({ ok: true, bytes: 4 })
  await flush()
  assert.ok(!types(w.sent).includes('upload') && !types(w.sent).includes('commit'))
})

test('a click on an image in the capture overlay saves that image, not a screenshot', async () => {
  const w = world({ region: { type: 'media', mediaType: 'image', srcUrl: 'https://cdn.test/a.png', pickedAt: 0.5 } })
  const id = (await w.region())!
  const d = w.dialog(id)
  await flush()
  await flush()
  assert.equal(w.shots(), 0)
  assert.deepEqual(w.pageCommands.slice(0, 2), ['select-region', 'inspect'])
  assert.equal(d.view()?.kind, 'image')
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.deepEqual(types(w.sent).slice(0, 1), ['download'])
  assert.equal(w.sent[0]!.url, 'https://cdn.test/a.png')
  assert.equal((w.sent[0]!.context as { mediaUrl: unknown }).mediaUrl, 'https://cdn.test/a.png')
})

test('a click on a stream in the capture overlay records it once confirmed', async () => {
  const w = world({ region: { type: 'media', mediaType: 'video', srcUrl: 'blob:https://x.test/9698', pickedAt: 0.5 } })
  const id = (await w.region())!
  const d = w.dialog(id)
  await flush()
  await flush()
  assert.equal(d.view()?.notice, 'record')
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.equal(w.sent[0]!.kind, 'video')
})

test('suggestions answer the prefix they were asked for', async () => {
  const w = world()
  const id = (await w.menu('https://cdn.test/a.png'))!
  const d = w.dialog(id)
  d.say({ type: 'suggest', prefix: 'ca', exclude: ['hero'] })
  await flush()
  await flush()
  assert.deepEqual(d.seen.find((m) => m.type === 'suggestions'), { type: 'suggestions', prefix: 'ca', tags: [{ name: 'card', uses: 3 }] })
  assert.deepEqual(w.sent.find((r) => r.t === 'suggest'), { t: 'suggest', prefix: 'ca', exclude: ['hero'], limit: 8 })
})

test('a dragged region is shot, cropped and staged as a screenshot after the dialog shows', async () => {
  const w = world()
  const id = (await w.region())!
  const d = w.dialog(id)
  await flush()
  await flush()
  assert.deepEqual(w.pageCommands.slice(0, 2), ['select-region', 'present'])
  assert.equal(w.shots(), 1)
  assert.deepEqual([...d.seen].reverse().find((m) => m.type === 'preview'), {
    type: 'preview',
    preview: { type: 'screenshot', dataUrl: 'data:image/png;base64,SHOT', rect: { x: 10, y: 20, width: 100, height: 50 }, viewport: { width: 800, height: 600 } },
  })
  d.say({ type: 'confirm', tags: ['blocks'], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.deepEqual(types(w.sent), ['upload', 'thumbnail', 'commit'])
  assert.equal(w.sent[0]!.kind, 'screenshot')
  assert.equal(w.captures.timeline(id)?.regionPicked, 0.5)
  assert.deepEqual(w.captures.timeline(id)?.beforeDialog, [])
})

test('a region cancelled with Esc ends with no dialog and no screenshot', async () => {
  const w = world({ region: { type: 'cancelled' } })
  const id = (await w.region())!
  assert.deepEqual(await w.captures.settled(id), { type: 'cancelled' })
  assert.deepEqual(w.pageCommands, ['select-region'])
  assert.equal(w.shots(), 0)
  assert.deepEqual(w.sent, [])
})

test('on a page no script can reach, the viewport is shot at once and the dialog opens in a window', async () => {
  const w = world({ injects: false })
  const id = (await w.region('chrome://extensions/'))!
  const d = w.dialog(id)
  await flush()
  await flush()
  assert.deepEqual(w.pageCommands, [])
  assert.deepEqual(w.windows, [1])
  assert.equal(w.shots(), 1)
  const preview = [...d.seen].reverse().find((m) => m.type === 'preview')
  assert.ok(preview?.type === 'preview' && preview.preview.type === 'screenshot' && preview.preview.rect === null)
  d.say({ type: 'cancel' })
  assert.deepEqual(await w.captures.settled(id), { type: 'cancelled' })
})

test('a stream whose page names its original downloads that file, and goes on in the background once confirmed', async () => {
  const original = 'https://video.twimg.com/amplify_video/1/vid/avc1/2560x1440/a.mp4?tag=29'
  const download = later<Staged>()
  const w = world({ original, answers: { download: () => download.promise } })
  const id = (await w.menu('blob:https://x.test/9698', 'video'))!
  const d = w.dialog(id)
  await flush()
  await flush()
  assert.equal(d.view()?.notice, null)
  assert.deepEqual(w.sent[0], {
    t: 'download',
    capture: id,
    kind: 'video',
    url: original,
    referer: tab.url,
    userAgent: 'test',
    context: { pageUrl: tab.url, pageTitle: 'Board', mediaUrl: original, capturedAt: (w.sent[0]!.context as { capturedAt: number }).capturedAt },
  })
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.deepEqual(w.dismissed, [id], 'the dialog goes at once')
  d.close()
  download.resolve({ outcome: 'file', bytes: 887288, mediaType: 'video/mp4', duplicate: null })
  assert.equal((await w.captures.settled(id)).type, 'saved', 'closing the dialog of a capture in the background does not cancel it')
  assert.ok(!w.pageCommands.includes('record'))
  assert.deepEqual(w.pills, ['working:影片處理中…', 'done:已儲存'])
})

test('with streams allowed, the playlist as long as the video is joined by the host instead of recording', async () => {
  const sources = [
    { url: 'https://cdn.test/other.m3u8', as: 'hls' as const, seenAt: 3 },
    { url: 'https://cdn.test/this.m3u8', as: 'hls' as const, seenAt: 2 },
  ]
  const w = world({ streams: { granted: true, sources }, answers: { probe: () => ({ durations: [60, 20.4], masters: [false, false] }) } })
  const id = (await w.menu('blob:https://site.test/6f1c', 'video'))!
  const d = w.dialog(id)
  await flush()
  await flush()
  assert.deepEqual(w.sent.find((r) => r.t === 'probe')?.sources, sources.map(({ url, as }) => ({ url, as })))
  const download = w.sent.find((r) => r.t === 'download')!
  assert.deepEqual([download.url, download.as], ['https://cdn.test/this.m3u8', 'hls'])
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.ok(!w.pageCommands.includes('record'))
})

test('with streams allowed but none as long as the video, it is recorded once confirmed', async () => {
  const sources = [{ url: 'https://cdn.test/other.m3u8', as: 'hls' as const, seenAt: 3 }]
  const w = world({ streams: { granted: true, sources }, answers: { probe: () => ({ durations: [60], masters: [false] }) } })
  const id = (await w.menu('blob:https://site.test/6f1c', 'video'))!
  const d = w.dialog(id)
  await flush()
  await flush()
  assert.equal(d.view()?.notice, 'record')
  assert.equal(d.view()?.offer, null)
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.ok(w.pageCommands.includes('record'))
  assert.ok(w.pills.at(-1) === 'done:已儲存')
})

test('without streams allowed, the dialog offers it, and a grant takes the offer away', async () => {
  const w = world()
  const id = (await w.menu('blob:https://site.test/6f1c', 'video'))!
  const d = w.dialog(id)
  const views = () => d.seen.flatMap((m) => (m.type === 'view' ? [m.view] : []))
  assert.equal(views()[0]?.finding, true, 'the first thing the dialog says is that it is looking, not that it will record')
  await flush()
  await flush()
  assert.equal(d.view()?.offer, 'streams')
  assert.equal(d.view()?.finding, false)
  const finding = views().map((v) => v.finding)
  assert.deepEqual(finding.slice(finding.indexOf(false)).filter((f) => f), [], 'once settled, it does not go back to looking')
  d.say({ type: 'streams-granted' })
  assert.equal(d.view()?.offer, null)
})

test("a video's thumbnail is its poster, the still the site shows for it, at the video's own size", async () => {
  const w = world({ poster: 'https://pbs.test/amplify_video_thumb/1/img/a.jpg' })
  const id = (await w.menu('https://cdn.test/clip.mp4', 'video'))!
  const d = w.dialog(id)
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  const sent = w.sent.find((r) => r.t === 'thumbnail')!
  assert.deepEqual([sent.webp, sent.width, sent.height, sent.source], ['UE9TVEVS', 400, 225, { width: 40, height: 30 }])
})

test('a poster that cannot be read leaves the thumbnail to the opening, not to the frame on screen', async () => {
  const w = world({ poster: 'https://pbs.test/a.jpg', posterFetch: async () => Promise.reject(new Error('the source answered 403')) })
  const id = (await w.menu('https://cdn.test/clip.mp4', 'video'))!
  const d = w.dialog(id)
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.equal(w.sent.find((r) => r.t === 'thumbnail')!.webp, openingThumb.webp)
})

test('a video kept only as a link, with nothing to decode, is shown by the frame on screen', async () => {
  const w = world({ state: { ...READY, protocol: 1 } })
  const id = (await w.menu('blob:https://site.test/6f1c', 'video'))!
  const d = w.dialog(id)
  d.say({ type: 'confirm', tags: [], note: '' })
  assert.equal((await w.captures.settled(id)).type, 'saved')
  assert.equal(w.sent.find((r) => r.t === 'thumbnail')!.webp, thumb.webp)
})
