import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type TestContext, test } from 'node:test'
import { EXTENSION_CHUNK_BYTES, HOST_MESSAGE_MAX_BYTES, PROTOCOL, negotiateProtocol } from '../src/capture-wire.js'
import { type HostProcess, spawnHost } from './helpers/native-host.js'

const hello = { t: 'hello', id: 0, protocol: PROTOCOL, extension: { version: 'test' } }
const context = { pageUrl: 'https://site.test/', pageTitle: 'Site', mediaUrl: null, capturedAt: 1 }
const capture = 'cap_0123456789abcdef'

const dataDir = () => mkdtempSync(join(tmpdir(), 'ezdesign-host-'))
const filesUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]))
    : []
const reply = (re: number) => (m: Record<string, unknown>) => (m.t === 'result' || m.t === 'error') && m.re === re
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function pngBytes(size: number): Buffer {
  const bytes = randomBytes(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  return bytes
}

function host(t: TestContext, dir = dataDir(), origin?: string): HostProcess {
  const spawned = spawnHost({ dataDir: dir, origin })
  t.after(() => spawned.child.kill('SIGKILL'))
  return spawned
}

async function greeted(t: TestContext, dir?: string): Promise<HostProcess> {
  const h = host(t, dir)
  h.send(hello)
  assert.equal((await h.next(reply(0))).t, 'result', h.stderr())
  return h
}

function sendUpload(h: HostProcess, bytes: Buffer, upTo = bytes.length, id = capture) {
  for (let offset = 0; offset < upTo; offset += EXTENSION_CHUNK_BYTES) {
    const data = bytes.subarray(offset, Math.min(offset + EXTENSION_CHUNK_BYTES, upTo)).toString('base64')
    h.send({ t: 'chunk', capture: id, offset, data })
  }
}

async function upload(h: HostProcess, bytes: Buffer, kind = 'screenshot', id = capture, next = 1) {
  h.send({ t: 'upload', id: next, capture: id, kind, size: bytes.length, context })
  assert.equal((await h.next(reply(next))).t, 'result')
  sendUpload(h, bytes, bytes.length, id)
  h.send({ t: 'upload-end', id: next + 1, capture: id, sha256: sha256(bytes) })
  return h.next(reply(next + 1))
}

async function closed(h: HostProcess): Promise<number | null> {
  h.child.stdin.end()
  return h.exited
}

test('CX-host-origin: a caller that is not the pinned extension is refused and nothing is written', async (t) => {
  for (const origin of ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', '']) {
    const dir = dataDir()
    const h = host(t, dir, origin)
    h.send(hello)
    assert.equal(await h.exited, 1)
    assert.deepEqual(h.frames, [])
    const lines = h.stderr().trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, origin ? /caller chrome-extension:\/\/a{32}\/ is not an allowed origin/ : /without a caller origin/)
    assert.deepEqual(readdirSync(dir), [])
  }
  const allowed = host(t)
  allowed.send(hello)
  const welcome = (await allowed.next(reply(0))) as { t: string; value: { protocol: number; library: { dir: string } } }
  assert.equal(welcome.t, 'result')
  assert.equal(welcome.value.protocol, 1)
  assert.equal(await closed(allowed), 0)
})

test('CX-p2-handshake: version skew is named, and nothing runs before hello', async (t) => {
  assert.deepEqual(
    [
      negotiateProtocol({ min: 1, max: 1 }, { min: 1, max: 1 }),
      negotiateProtocol({ min: 1, max: 2 }, { min: 1, max: 1 }),
      negotiateProtocol({ min: 2, max: 3 }, { min: 1, max: 1 }),
      negotiateProtocol({ min: 1, max: 1 }, { min: 2, max: 2 }),
    ],
    [1, 1, null, null],
  )

  const dir = dataDir()
  const skewed = host(t, dir)
  skewed.send({ ...hello, protocol: { min: 5, max: 6 } })
  const { error } = (await skewed.next(reply(0))) as { error?: { code: string; host: unknown } }
  assert.deepEqual([error?.code, error?.host], ['incompatible', { min: 1, max: 1 }])
  assert.equal(await skewed.exited, 0)
  assert.deepEqual(readdirSync(dir), [], 'an incompatible extension never opens the library')

  const early = host(t)
  early.send({
    t: 'download',
    id: 7,
    capture,
    kind: 'image',
    url: 'http://127.0.0.1:9/a.png',
    referer: null,
    userAgent: 'test',
    context,
  })
  const answer = (await early.next(reply(7))) as { error?: { code: string } }
  assert.equal(answer.error?.code, 'bad-request')
  early.send(hello)
  assert.equal((await early.next(reply(0))).t, 'result', 'the host is still there to greet')
  assert.equal(await closed(early), 0)
})

test('CX-chunked: a 20 MB capture sent in chunks arrives byte-identical, in frames under 1 MiB', async (t) => {
  const dir = dataDir()
  const h = await greeted(t, dir)
  const bytes = pngBytes(20 * 1024 * 1024)
  const staged = (await upload(h, bytes)) as { value: { outcome: string; bytes: number; mediaType: string } }
  assert.deepEqual(staged.value, { outcome: 'file', bytes: bytes.length, mediaType: 'image/png', duplicate: null })

  h.send({ t: 'read', id: 3, capture })
  assert.deepEqual((await h.next(reply(3))) as unknown, { t: 'result', re: 3, value: { bytes: bytes.length } })
  const pieces = h.frames.filter((f) => f.message.t === 'bytes')
  assert.deepEqual(
    pieces.map((p) => p.message.seq),
    pieces.map((_, i) => i),
  )
  const readBack = Buffer.concat(pieces.map((p) => Buffer.from(String(p.message.data), 'base64')))
  assert.equal(sha256(readBack), sha256(bytes))
  assert.ok(Math.max(...h.frames.map((f) => f.bytes + 4)) <= HOST_MESSAGE_MAX_BYTES)

  h.send({ t: 'commit', id: 4, capture, tags: ['shot'], note: '' })
  const committed = (await h.next(reply(4))) as { value: { item: { tags: string[] }; merged: boolean } }
  assert.deepEqual([committed.value.item.tags, committed.value.merged], [['shot'], false])
  assert.equal(await closed(h), 0)
  const blobs = filesUnder(join(dir, 'library', 'blobs'))
  assert.equal(blobs.length, 1)
  assert.equal(sha256(readFileSync(blobs[0]!)), sha256(bytes))
})

test('CX-chunked: a wrong sha256 or a gap answers integrity and leaves the stage empty', async (t) => {
  const dir = dataDir()
  const h = await greeted(t, dir)
  const bytes = pngBytes(3 * 1024 * 1024)
  h.send({ t: 'upload', id: 1, capture, kind: 'image', size: bytes.length, context })
  await h.next(reply(1))
  sendUpload(h, bytes)
  h.send({ t: 'upload-end', id: 2, capture, sha256: '0'.repeat(64) })
  assert.equal(((await h.next(reply(2))) as { error?: { code: string } }).error?.code, 'integrity')

  const gap = 'cap_gap_0123456789'
  h.send({ t: 'upload', id: 3, capture: gap, kind: 'image', size: 10, context })
  await h.next(reply(3))
  h.send({ t: 'chunk', capture: gap, offset: 5, data: Buffer.alloc(5).toString('base64') })
  h.send({ t: 'upload-end', id: 4, capture: gap, sha256: '0'.repeat(64) })
  assert.equal(((await h.next(reply(4))) as { error?: { code: string } }).error?.code, 'integrity')

  h.send({ t: 'commit', id: 5, capture, tags: [], note: '' })
  assert.equal(((await h.next(reply(5))) as { error?: { code: string } }).error?.code, 'bad-request')
  const staging = filesUnder(join(dir, 'library', 'staging'))
  assert.deepEqual(staging, [])
  assert.equal(await closed(h), 0)
})

test('CX-chunked: a transfer cut off midway leaves no file and no row', async (t) => {
  const dir = dataDir()
  const bytes = pngBytes(20 * 1024 * 1024)
  for (const cut of ['port-closed', 'killed'] as const) {
    const h = await greeted(t, dir)
    h.send({ t: 'upload', id: 1, capture, kind: 'screenshot', size: bytes.length, context })
    await h.next(reply(1))
    sendUpload(h, bytes, 2 * EXTENSION_CHUNK_BYTES)
    if (cut === 'port-closed') h.child.stdin.end()
    else {
      h.child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') throw error
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      h.child.kill('SIGKILL')
    }
    await h.exited
  }
  const next = await greeted(t, dir)
  assert.deepEqual(readdirSync(join(dir, 'library', 'staging')).length, 1, "only the new host's own dir")
  assert.deepEqual(filesUnder(join(dir, 'library', 'staging')), [])
  assert.deepEqual(filesUnder(join(dir, 'library', 'blobs')), [])
  assert.equal(await closed(next), 0)
  const db = new DatabaseSync(join(dir, 'library', 'library.db'))
  assert.deepEqual({ ...db.prepare('SELECT count(*) AS n FROM items').get() }, { n: 0 })
  db.close()
})

async function fixtures(t: TestContext, routes: Record<string, (res: ServerResponse, req: IncomingMessage) => void>) {
  const server: Server = createServer((req, res) => {
    const route = routes[req.url ?? '']
    if (route) route(res, req)
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const download = (id: number, url: string, kind = 'image', cap = `cap_dl_${id}_000000`) => ({
  t: 'download',
  id,
  capture: cap,
  kind,
  url,
  referer: 'https://site.test/',
  userAgent: 'ezdesign-test',
  context: { ...context, mediaUrl: url },
})

test('the host downloads a capture itself, and says why when it cannot', async (t) => {
  const image = pngBytes(256 * 1024)
  let sent: Record<string, string | undefined> = {}
  const base = await fixtures(t, {
    '/a.png': (res, req) => {
      sent = { referer: req.headers.referer, userAgent: req.headers['user-agent'] }
      res.writeHead(200, { 'content-type': 'image/png' }).end(image)
    },
    '/private.png': (res) => res.writeHead(403).end(),
    '/gone.png': (res) => res.writeHead(500).end(),
    '/page.png': (res) => res.writeHead(200, { 'content-type': 'image/png' }).end('<!doctype html><p>sign in'),
    '/huge.mp4': (res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(250_000_000) })
      res.write(Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypisom'), Buffer.alloc(1024)]))
    },
  })
  const dir = dataDir()
  const h = await greeted(t, dir)

  h.send(download(1, `${base}/a.png`))
  const staged = (await h.next(reply(1))) as { value: { outcome: string; bytes: number; duplicate: unknown } }
  assert.deepEqual([staged.value.outcome, staged.value.bytes], ['file', image.length])
  assert.deepEqual(sent, { referer: 'https://site.test/', userAgent: 'ezdesign-test' })

  h.send(download(2, `${base}/private.png`))
  assert.deepEqual((await h.next(reply(2))).error, { code: 'source-refused', message: 'the source answered 403', status: 403 })
  h.send(download(3, `${base}/gone.png`))
  assert.deepEqual((await h.next(reply(3))).error, { code: 'source-failed', message: 'the source answered 500', status: 500 })
  h.send(download(4, `${base}/page.png`))
  assert.equal(((await h.next(reply(4))).error as { code: string }).code, 'source-failed')

  h.send(download(5, `${base}/huge.mp4`, 'video'))
  const tooLarge = (await h.next(reply(5))) as { value: { outcome: string; bytes: number } }
  assert.deepEqual([tooLarge.value.outcome, tooLarge.value.bytes], ['too-large', 250_000_000])

  h.send({ t: 'commit', id: 6, capture: 'cap_dl_1_000000', tags: ['logo'], note: '好看' })
  assert.equal((await h.next(reply(6))).t, 'result')
  assert.equal(await closed(h), 0)
  assert.equal(filesUnder(join(dir, 'library', 'blobs')).length, 1)
  assert.deepEqual(filesUnder(join(dir, 'library', 'staging')), [])
})

test('a discard while the download runs cancels it and keeps nothing', async (t) => {
  const base = await fixtures(t, {
    '/slow.png': (res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.write(pngBytes(64 * 1024))
    },
  })
  const dir = dataDir()
  const h = await greeted(t, dir)
  h.send(download(1, `${base}/slow.png`, 'image', capture))
  await h.next((m) => m.t === 'progress' && m.re === 1)
  h.send({ t: 'discard', id: 2, capture })
  assert.deepEqual((await h.next(reply(2))).value, {})
  assert.equal(((await h.next(reply(1))).error as { code: string }).code, 'cancelled')
  h.send({ t: 'discard', id: 3, capture })
  assert.deepEqual((await h.next(reply(3))).value, {}, 'discard is idempotent')
  assert.equal(await closed(h), 0)
  assert.deepEqual(filesUnder(join(dir, 'library', 'staging')), [])
})

test('a stream link keeps its frame, uploaded after it was staged', async (t) => {
  const dir = dataDir()
  const h = await greeted(t, dir)
  h.send({ t: 'link', id: 1, capture, playbackTime: 3.5, context })
  assert.deepEqual((await h.next(reply(1))).value, { outcome: 'stream-link', bytes: null, mediaType: null, duplicate: null })
  const frame = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(frame)
  frame.writeUInt32BE(13, 8)
  frame.write('IHDR', 12, 'ascii')
  frame.writeUInt32BE(1280, 16)
  frame.writeUInt32BE(720, 20)
  const staged = (await upload(h, frame, 'frame', capture, 2)) as { value: { outcome: string } }
  assert.equal(staged.value.outcome, 'stream-link')
  h.send({ t: 'commit', id: 4, capture, tags: [], note: '' })
  assert.equal((await h.next(reply(4))).t, 'result')
  h.send({ t: 'commit', id: 5, capture, tags: ['ignored'], note: '' })
  assert.deepEqual((await h.next(reply(5))).value, (await h.next(reply(4))).value, 'a retried commit answers the same')
  assert.equal(await closed(h), 0)
  const blobs = filesUnder(join(dir, 'library', 'blobs'))
  assert.deepEqual(blobs.map((b) => readFileSync(b).equals(frame)), [true])
})

test('suggestions come from the library the host writes', async (t) => {
  const h = await greeted(t)
  await upload(h, pngBytes(1024), 'image')
  h.send({ t: 'commit', id: 3, capture, tags: ['Card', 'cta'], note: '' })
  await h.next(reply(3))
  h.send({ t: 'suggest', id: 4, prefix: 'C', exclude: ['cta'], limit: 8 })
  assert.deepEqual((await h.next(reply(4))).value, { tags: [{ name: 'card', uses: 1 }] })
  assert.equal(await closed(h), 0)
})
