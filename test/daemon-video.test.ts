import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openLibrary } from '../src/library/index.js'
import { DaemonWorld } from './helpers/daemon.js'
import { png, webp } from './helpers/media.js'

const world = await DaemonWorld.create()
after(() => world.dispose())
let api = ''
let project = ''

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypisom'), Buffer.alloc(1024, 3)])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64')
const anchor = { selector: 'main', page: '/' }

const call = async <T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const res = await fetch(api + path, init)
  return { status: res.status, body: (await res.json().catch(() => null)) as T }
}
const post = (path: string, body: unknown, method = 'POST') =>
  call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const upload = (name: string, mime: string, bytes: Buffer) =>
  call<{ id: string; name: string; video?: { state: string } }>('/attachments', {
    method: 'POST',
    headers: { 'content-type': mime, 'x-ez-name': encodeURIComponent(name) },
    body: new Uint8Array(bytes),
  })
const pendingVideos = async () => (await call<{ pendingVideos?: string[] }>('/state')).body.pendingVideos ?? []
const ready = {
  state: 'ready',
  durationMs: 3000,
  width: 1920,
  height: 1080,
  fps: 60,
  audio: false,
  motion: [{ fromMs: 1200, toMs: 1400, region: { x: 1140, y: 780, width: 540, height: 300 }, frames: 12, shown: 12, sheet: 2 }],
  sheets: [JPEG, JPEG],
}

before(async () => {
  world.spawnDaemon()
  const { port } = await world.liveDaemon()
  project = realpathSync(mkdtempSync(join(world.dataDir, 'project-')))
  const { shellUrl } = await world.openSession(port, { project })
  api = `${new URL(shellUrl).origin}/__ezdesign/api`
})

test('a pasted video waits in the queue, holds the send back, and reaches poll with its sheets once settled', async () => {
  const rec = await upload('rec.mp4', 'video/mp4', MP4)
  assert.equal(rec.status, 200)
  assert.deepEqual(rec.body.video, { state: 'pending' })
  assert.deepEqual(await pendingVideos(), [rec.body.id])

  const range = await fetch(`${api}/attachments/${rec.body.id}/content`, { headers: { range: 'bytes=4-11' } })
  assert.equal(range.status, 206)
  assert.equal(await range.text(), 'ftypisom')

  assert.equal((await post('/annotations', { kind: 'element', comment: '[file 1] 的 toast', anchor, attachments: [rec.body.id] })).status, 200)
  const held = await post('/send', { note: null, attachments: [] })
  assert.equal(held.status, 409)
  assert.equal((held.body as { error: string }).error, '影片還在處理，處理完才能交給 agent')

  assert.deepEqual((await post(`/attachments/${rec.body.id}/video`, ready, 'PUT')).body, { state: 'ready' })
  assert.deepEqual((await post(`/attachments/${rec.body.id}/video`, { state: 'failed', reason: 'crashed', detail: '' }, 'PUT')).body, {
    state: 'ready',
  })
  assert.deepEqual(await pendingVideos(), [])
  assert.equal((await post('/send', { note: null, attachments: [] })).status, 200)

  const polled = await world.run(['poll'], { cwd: project })
  assert.equal(polled.code, 0, polled.stderr)
  const batch = JSON.parse(polled.stdout) as {
    items: { label: string; attachments: { name: string; video: { overview: string; motion: { sheet: string }[]; read: string } }[] }[]
  }
  const [item] = batch.items
  assert.match(item!.label, /\[file 1: rec\.mp4, video\]/)
  const { video } = item!.attachments[0]!
  assert.match(video.read, /^A recording you cannot open/)
  assert.deepEqual([...readFileSync(video.overview)], [0xff, 0xd8, 0xff, 0xe0, 0, 16])
  assert.ok(existsSync(video.motion[0]!.sheet))
})

test('an upload over the limit for its type is a 413, and a video is let in past the image cap', async () => {
  const big = Buffer.alloc(9 * 1024 * 1024, 1)
  assert.equal((await upload('big.png', 'image/png', big)).status, 413)
  const video = await upload('big.mp4', 'video/mp4', Buffer.concat([MP4, big]))
  assert.equal(video.status, 200)
  assert.equal(video.body.video?.state, 'pending')
})

test('a video deleted mid-digest is gone: its bytes 404 and a late settle writes nothing', async () => {
  const rec = await upload('gone.mp4', 'video/mp4', MP4)
  assert.equal((await call(`/attachments/${rec.body.id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await fetch(`${api}/attachments/${rec.body.id}/content`, { method: 'HEAD' })).status, 404)
  assert.equal((await post(`/attachments/${rec.body.id}/video`, ready, 'PUT')).status, 404)
  assert.ok(!(await pendingVideos()).includes(rec.body.id))
})

test('a malformed settle is refused with the reason, and the video stays pending', async () => {
  const rec = await upload('bad.mp4', 'video/mp4', MP4)
  const refused = await post(`/attachments/${rec.body.id}/video`, { ...ready, sheets: [JPEG] }, 'PUT')
  assert.equal(refused.status, 400)
  assert.equal((refused.body as { error: string }).error, 'a stretch names a sheet that is not there')
  assert.ok((await pendingVideos()).includes(rec.body.id))
})

test('an explore cannot start on a video still being digested', async () => {
  const rec = await upload('explore.mp4', 'video/mp4', MP4)
  const res = await post('/explore/start', { anchor, capture: { html: '<b>x</b>' }, direction: '像 [file 1]', attachments: [rec.body.id] })
  assert.equal(res.status, 409)
  assert.equal((res.body as { error: string }).error, '影片還在處理，處理完才能交給 agent')
})

test('a library video becomes a pending attachment, and a link item of a video carries origin.videoFrame', async () => {
  const library = await openLibrary({ dir: join(world.dataDir, 'library') })
  const source = { pageUrl: 'https://ref.test/v', pageTitle: 'Motion', mediaUrl: null, capturedAt: 1 }
  try {
    const stage = library.stage({ kind: 'video', source })
    await stage.write(MP4)
    const file = await stage.finish()
    await file.setThumbnail({ webp: webp(40, 20), width: 40, height: 20, source: { width: 40, height: 20 } })
    const fileItem = (await file.commit({ tags: [], note: '' })).item

    const link = library.stageLink({ kind: 'video', source: { ...source, pageTitle: 'Stream' }, playbackTime: 12.3 })
    await link.attachFrame(png(40, 20))
    await link.setThumbnail({ webp: webp(40, 20), width: 40, height: 20, source: { width: 40, height: 20 } })
    const linkItem = (await link.commit({ tags: [], note: '' })).item

    const attached = await post('/attachments/library', { ids: [fileItem.id, linkItem.id] })
    const [video, still] = attached.body as unknown as { id: string; mime: string; video?: unknown; origin: { videoFrame?: unknown } }[]
    assert.equal(video!.mime, 'video/mp4')
    assert.deepEqual(video!.video, { state: 'pending' })
    assert.ok((await pendingVideos()).includes(video!.id))
    assert.equal(still!.mime, 'image/png')
    assert.equal(still!.video, undefined)
    assert.deepEqual(still!.origin.videoFrame, { reason: 'stream', playbackTime: 12.3 })
  } finally {
    library.close()
  }
})
