import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Staged } from '../src/capture-wire.js'
import type { CaptureId, DialogToWorker, HostState, PageCommand, WorkerToDialog } from '../src/extension/shared/messages.js'
import { createCaptures } from '../src/extension/worker/capture.js'
import { type DialogPort, HostFailure, type HostLink } from '../src/extension/worker/ports.js'

const READY: HostState = { type: 'ready', version: 'test', node: 'v24', libraryDir: '/lib' }
const tab = { id: 7, windowId: 1, url: 'https://site.test/board', title: 'Board' }
const thumb = { webp: 'UklGRg==', width: 4, height: 3, source: { width: 40, height: 30 } }
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

function world(options: { state?: HostState; answers?: Record<string, Answer>; mounted?: boolean } = {}) {
  const sent: Record<string, unknown>[] = []
  const pageCommands: PageCommand['type'][] = []
  const answers: Record<string, Answer> = {
    download: () => file(),
    upload: () => ({}),
    'upload-end': () => file(),
    link: () => ({ outcome: 'stream-link', bytes: null, mediaType: null, duplicate: null }),
    thumbnail: () => ({}),
    commit: (r) => ({ item: { id: `item-${String(r.capture)}`, tags: r.tags, note: r.note, hasThumbnail: true }, merged: false }),
    discard: () => ({}),
    suggest: () => ({ tags: [{ name: 'card', uses: 3 }] }),
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
  const dismissed: string[] = []
  const captures = createCaptures({
    host,
    media: {
      warm: async () => {},
      thumbnail: async (pieces) => {
        for await (const _ of pieces) void _
        return thumb
      },
      crop: async () => ({ original: null, thumb }),
    },
    page: {
      ensure: async () => true,
      async send(_tab, _frame, command) {
        pageCommands.push(command.type)
        if (command.type === 'inspect') {
          return { found: true, viewport: { width: 800, height: 600 }, rect: null, natural: { width: 40, height: 30 }, video: command.mediaType === 'video' ? { currentTime: 3.5, frame: { type: 'encoded', thumb, png: 'iVBORw0KGgo=' } } : null } as never
        }
        if (command.type === 'present') return { mounted: options.mounted ?? true, handedOff: true } as never
        if (command.type === 'dismiss') dismissed.push(command.captureId)
        return {} as never
      },
    },
    browser: {
      captureVisibleTab: async () => 'data:image/png;base64,',
      dialogPath: (id) => `dialog.html#${id}`,
      openDialogWindow: async () => 1,
      closeWindow: async () => {},
      fetchWithCookies: async () => new Uint8Array([1, 2, 3]),
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

  return { captures, sent, pageCommands, dismissed, dialog, menu, setState: (s: HostState) => (state = s) }
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

test('a stream saves as a link with its time and the full-size frame', async () => {
  const w = world()
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
