import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type CaptureSource,
  type Library,
  type ReadyStage,
  LibraryError,
  VIDEO_CAP_BYTES,
  openLibrary,
} from '../src/library/index.js'
import { ulid } from '../src/library/internal/ulid.js'
import { png, webp } from './helpers/media.js'

const LIBRARY_ENTRY = fileURLToPath(new URL('../src/library/index.ts', import.meta.url))
const REPO = fileURLToPath(new URL('..', import.meta.url))

const source: CaptureSource = {
  pageUrl: 'https://site.test/board',
  pageTitle: 'Board',
  mediaUrl: 'https://cdn.test/a.png',
  capturedAt: 1,
}

const mp4Head = () => {
  const head = Buffer.alloc(32)
  head.writeUInt32BE(32, 0)
  head.write('ftypisom', 4, 'ascii')
  return head
}

function fresh(): { dir: string; open(): Promise<Library> } {
  const dir = mkdtempSync(join(tmpdir(), 'ezdesign-library-'))
  return { dir, open: () => openLibrary({ dir }) }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function stageBytes(library: Library, bytes: Buffer, from: CaptureSource = source): Promise<ReadyStage> {
  const stage = library.stage({ kind: 'image', source: from, expectedBytes: bytes.length })
  assert.equal(await stage.write(bytes), 'accepted')
  return stage.finish({ sha256: sha256(bytes) })
}

async function save(library: Library, seed: string, tags: string[], note = '', from: CaptureSource = source) {
  return (await stageBytes(library, png(10, 10, 64, seed), from)).commit({ tags, note })
}

function rawDb(dir: string, run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(join(dir, 'library.db'))
  try {
    run(db)
  } finally {
    db.close()
  }
}

function child(t: TestContext, script: string): { proc: ChildProcessWithoutNullStreams; line(match: string): Promise<string>; exited: Promise<number | null> } {
  const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: REPO })
  t.after(() => proc.kill('SIGKILL'))
  let out = ''
  const waiters: { match: string; resolve: (line: string) => void }[] = []
  proc.stdout.setEncoding('utf8').on('data', (d: string) => {
    out += d
    for (const w of [...waiters]) {
      const line = out.split('\n').find((l) => l.startsWith(w.match))
      if (line !== undefined) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(line)
      }
    }
  })
  let stderr = ''
  proc.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
  const exited = new Promise<number | null>((resolve) => proc.on('exit', resolve))
  return {
    proc,
    exited: exited.then((code) => {
      assert.equal(stderr.trim(), '', `child stderr:\n${stderr}`)
      return code
    }),
    line: (match) =>
      Promise.race([
        new Promise<string>((resolve) => {
          const line = out.split('\n').find((l) => l.startsWith(match))
          if (line !== undefined) resolve(line)
          else waiters.push({ match, resolve })
        }),
        exited.then((code) => {
          throw new Error(`child exited ${code} before "${match}":\n${stderr}`)
        }),
      ]),
  }
}

test('CX-cancel: a discarded stage leaves no row and no file, and discarding again is fine', async () => {
  const { dir, open } = fresh()
  const library = await open()
  const ready = await stageBytes(library, png(800, 600, 3_000_000))
  await ready.discard()
  await ready.discard()
  assert.equal(library.find({}).items.length, 0)
  assert.deepEqual(filesUnder(join(dir, 'blobs')), [])
  assert.deepEqual(filesUnder(join(dir, 'thumbs')), [])
  assert.deepEqual(filesUnder(join(dir, 'staging')), [])
  rawDb(dir, (db) => assert.deepEqual({ ...db.prepare('SELECT count(*) AS n FROM items').get() }, { n: 0 }))
  library.close()
  assert.deepEqual(readdirSync(join(dir, 'staging')), [])
})

test('CX-cancel: a stage never confirmed before its process died is swept by the next open', async (t) => {
  const { dir } = fresh()
  const holder = child(t, `
    import { createHash } from 'node:crypto'
    import { openLibrary } from ${JSON.stringify(LIBRARY_ENTRY)}
    const library = await openLibrary({ dir: ${JSON.stringify(dir)} })
    const stage = library.stage({ kind: 'image', source: ${JSON.stringify(source)} })
    const bytes = Buffer.alloc(3_000_000, 7)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    await stage.write(bytes)
    await stage.finish()
    console.log('staged')
    setInterval(() => {}, 1000)`)
  await holder.line('staged')
  assert.equal(readdirSync(join(dir, 'staging')).length, 1)
  assert.equal(filesUnder(join(dir, 'staging')).length, 1, 'the child staged its bytes')
  holder.proc.kill('SIGKILL')
  await holder.exited

  const library = await openLibrary({ dir })
  assert.equal(library.find({}).items.length, 0)
  assert.deepEqual(filesUnder(join(dir, 'staging')), [], 'only the new handle owns a (still empty) dir')
  assert.deepEqual(filesUnder(join(dir, 'blobs')), [])
  library.close()
  assert.deepEqual(readdirSync(join(dir, 'staging')), [])
})

test('a committed image reads back exactly: bytes, metadata, thumbnail, tags and note', async () => {
  const { open } = fresh()
  const library = await open()
  const bytes = png(1200, 900, 5000)
  const ready = await stageBytes(library, bytes)
  assert.ok(ready.type === 'file')
  assert.deepEqual(ready.file, { sha256: sha256(bytes), mediaType: 'image/png', bytes: 5000 })
  assert.equal(ready.duplicateOf, null)
  await ready.setThumbnail({ webp: webp(400, 300), width: 400, height: 300, source: { width: 1200, height: 900 } })
  const { item, merged } = await ready.commit({ tags: ['Hero', ' hero ', '卡片', '  ', 'a,b'], note: '漸層按鈕\n第二行' })

  assert.equal(merged, false)
  assert.match(item.id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.equal(item.kind, 'image')
  assert.ok(item.content.type === 'file')
  assert.equal(sha256(readFileSync(item.content.path)), sha256(bytes))
  assert.equal(item.content.path, join(library.dir, 'blobs', sha256(bytes).slice(0, 2), `${sha256(bytes)}.png`))
  assert.deepEqual([item.content.mediaType, item.content.bytes], ['image/png', 5000])
  assert.deepEqual(item.source, source)
  assert.deepEqual(item.dimensions, { width: 1200, height: 900 })
  assert.deepEqual([item.thumbnail?.width, item.thumbnail?.height], [400, 300])
  assert.deepEqual(readFileSync(item.thumbnail!.path), webp(400, 300))
  assert.deepEqual(item.tags, ['hero', '卡片'])
  assert.equal(item.note, '漸層按鈕\n第二行')
  assert.deepEqual(library.get(item.id), item)
  assert.deepEqual(await ready.commit({ tags: ['ignored'], note: 'ignored' }), { item, merged: false }, 'commit is idempotent')
  await ready.discard()
  assert.deepEqual(library.get(item.id), item, 'discard after commit is a no-op')
  library.close()
})

test('CX-duplicate: staging saved bytes reports the item, and confirming merges into it', async () => {
  const { dir, open } = fresh()
  const library = await open()
  const bytes = png(640, 480, 1_000_000, 'B')
  const first = await (await stageBytes(library, bytes)).commit({ tags: ['Landing Page', 'hero'], note: '字距好' })

  const again = await stageBytes(library, bytes, { ...source, pageUrl: 'https://elsewhere.test/' })
  assert.equal(again.duplicateOf?.id, first.item.id)
  assert.deepEqual(again.duplicateOf?.tags, ['hero', 'landing Page'])
  const second = await again.commit({ tags: ['landing page', '排版'], note: '顏色也好' })

  assert.equal(second.merged, true)
  assert.equal(second.item.id, first.item.id)
  const { items } = library.find({})
  assert.equal(items.length, 1)
  assert.deepEqual(items[0]!.tags, ['hero', 'landing Page', '排版'])
  assert.equal(items[0]!.note, '字距好\n\n顏色也好')
  assert.equal(items[0]!.source.pageUrl, 'https://site.test/board')
  assert.equal(filesUnder(join(dir, 'blobs')).length, 1)

  const third = await (await stageBytes(library, bytes)).commit({ tags: [], note: '' })
  assert.equal(third.item.note, '字距好\n\n顏色也好', 'an empty note keeps the one there')
  const fourth = await (await stageBytes(library, bytes)).commit({ tags: [], note: '字距好\n\n顏色也好\n留白也好' })
  assert.equal(fourth.item.note, '字距好\n\n顏色也好\n留白也好', 'a pre-filled note that was extended replaces the old one')
  library.close()
})

test('CX-video-cap: a video over the cap keeps only its frame and thumbnail', async () => {
  const { dir, open } = fresh()
  const library = await open()

  const declared = library.stage({ kind: 'video', source, expectedBytes: 250_000_000 })
  assert.equal(await declared.write(mp4Head()), 'over-cap')
  const first = await declared.finish()

  const streamed = library.stage({ kind: 'video', source })
  const chunk = Buffer.alloc(8 * 1024 * 1024)
  mp4Head().copy(chunk)
  const outcomes: string[] = []
  for (let sent = 0; sent < 201_000_000; sent += chunk.length) {
    outcomes.push(await streamed.write(chunk.subarray(0, Math.min(chunk.length, 201_000_000 - sent))))
  }
  assert.deepEqual(outcomes, [...Array(23).fill('accepted'), 'over-cap'])
  assert.deepEqual(filesUnder(join(dir, 'staging')), [], 'the stage dropped its bytes at the cap')
  const second = await streamed.finish()

  assert.ok(first.type === 'link' && second.type === 'link')
  assert.deepEqual(first.link, { reason: 'too-large', bytes: 250_000_000 })
  assert.deepEqual(second.link, { reason: 'too-large', bytes: 201_000_000 })
  assert.ok(second.link.bytes! >= VIDEO_CAP_BYTES)

  for (const [i, ready] of [first, second].entries()) {
    await ready.setThumbnail({ webp: webp(400, 225), width: 400, height: 225, source: { width: 1920, height: 1080 } })
    await ready.attachFrame(png(1920, 1080, 4096, `frame-${i}`))
    const { item } = await ready.commit({ tags: [], note: '' })
    assert.ok(item.content.type === 'link')
    assert.equal(item.content.reason, 'too-large')
    assert.equal(item.content.frame?.mediaType, 'image/png')
    assert.equal(sha256(readFileSync(item.content.frame!.path)), sha256(png(1920, 1080, 4096, `frame-${i}`)))
    assert.deepEqual(item.dimensions, { width: 1920, height: 1080 })
    assert.ok(item.thumbnail && existsSync(item.thumbnail.path))
  }
  const blobs = filesUnder(join(dir, 'blobs'))
  assert.equal(blobs.length, 2)
  assert.ok(blobs.every((f) => f.endsWith('.png') && statSync(f).size < 10_000_000))
  assert.deepEqual(filesUnder(join(dir, 'staging')), [])
  library.close()
})

test('a stream is a link with its playback time and frame, and never merges', async () => {
  const { open } = fresh()
  const library = await open()
  const commitStream = async () => {
    const ready = library.stageLink({ kind: 'video', source, playbackTime: 12.5 })
    assert.equal(ready.duplicateOf, null)
    await ready.attachFrame(png(1280, 720, 512, 'same frame'))
    return ready.commit({ tags: ['motion'], note: '' })
  }
  const a = await commitStream()
  const b = await commitStream()
  assert.equal(b.merged, false)
  assert.notEqual(a.item.id, b.item.id)
  assert.ok(a.item.content.type === 'link')
  assert.deepEqual([a.item.content.reason, a.item.content.playbackTime, a.item.content.bytes], ['stream', 12.5, null])
  assert.equal(a.item.thumbnail, null)
  library.close()
})

test('the library refuses bytes that are not what they claim', async () => {
  const { dir, open } = fresh()
  const library = await open()
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'resolved',
      (e: unknown) => (e instanceof LibraryError ? e.code : String(e)),
    )

  const wrongHash = library.stage({ kind: 'image', source })
  await wrongHash.write(png(1, 1))
  assert.equal(await code(wrongHash.finish({ sha256: '0'.repeat(64) })), 'integrity')

  const page = library.stage({ kind: 'image', source })
  await page.write(Buffer.from('<!doctype html><title>Sign in</title>'))
  assert.equal(await code(page.finish()), 'unsupported-media')

  const notVideo = library.stage({ kind: 'video', source })
  await notVideo.write(png(1, 1))
  assert.equal(await code(notVideo.finish()), 'unsupported-media')

  const ready = await stageBytes(library, png(10, 10))
  assert.equal(await code(ready.setThumbnail({ webp: png(1, 1), width: 1, height: 1, source: { width: 1, height: 1 } })), 'integrity')
  assert.equal(await code(ready.setThumbnail({ webp: webp(401, 10), width: 401, height: 10, source: { width: 1, height: 1 } })), 'integrity')
  assert.equal(await code(ready.setThumbnail({ webp: webp(40, 10), width: 400, height: 100, source: { width: 1, height: 1 } })), 'integrity')
  await ready.discard()
  assert.equal(await code(ready.commit({ tags: [], note: '' })), 'stage-closed')

  assert.deepEqual(filesUnder(join(dir, 'staging')), [])
  assert.equal(library.find({}).items.length, 0)
  library.close()
})

test('CX-concurrent: two processes committing at once both succeed', async (t) => {
  const { dir } = fresh()
  const committer = (n: number) =>
    child(t, `
      import { createInterface } from 'node:readline'
      import { openLibrary } from ${JSON.stringify(LIBRARY_ENTRY)}
      const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
      const image = (seed) => {
        const bytes = Buffer.alloc(200_000, seed)
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
        bytes.write(seed, 8)
        return bytes
      }
      const commit = async (bytes) => {
        const stage = library.stage({ kind: 'image', source: ${JSON.stringify(source)} })
        await stage.write(bytes)
        return (await stage.finish()).commit({ tags: ['ref'], note: '' })
      }
      const library = await openLibrary({ dir: ${JSON.stringify(dir)} })
      console.log('ready')
      await lines.next()
      await Promise.all(Array.from({ length: 50 }, (_, i) => commit(image('p${n}-' + i))))
      console.log('committed')
      await lines.next()
      const { merged } = await commit(image('C'))
      console.log('merged ' + merged)
      library.close()`)
  const children = [committer(1), committer(2)]
  await Promise.all(children.map((c) => c.line('ready')))
  for (const c of children) c.proc.stdin.write('go\n')
  await Promise.all(children.map((c) => c.line('committed')))
  for (const c of children) c.proc.stdin.end('go\n')
  const merged = await Promise.all(children.map((c) => c.line('merged')))
  assert.deepEqual(await Promise.all(children.map((c) => c.exited)), [0, 0])
  assert.deepEqual(merged.sort(), ['merged false', 'merged true'])

  const library = await openLibrary({ dir })
  const { items } = library.find({ tags: ['ref'], limit: 500 })
  assert.equal(items.length, 101)
  assert.ok(items.every((i) => i.tags.join() === 'ref'))
  library.close()
  rawDb(dir, (db) => assert.deepEqual({ ...db.prepare('PRAGMA integrity_check').get() }, { integrity_check: 'ok' }))
})

test('CX-p1-suggest-order: prefix by key, live uses descending, then key', async () => {
  const { dir, open } = fresh()
  const library = await open()
  await save(library, '1', ['card', 'Carousel', 'CTA'])
  await save(library, '2', ['card', 'carousel', 'dark'])
  await save(library, '3', ['Card', 'Carousel', 'cart'])
  await save(library, '4', ['CTA', 'dark'])
  const gone = await save(library, '5', ['cargo'])
  await save(library, '6', [])
  rawDb(dir, (db) => db.prepare('UPDATE items SET deleted_at = 1 WHERE id = ?').run(gone.item.id))

  const named = (list: { name: string; uses: number }[]) => list.map((t) => `${t.name} ${t.uses}`)
  assert.deepEqual(named(library.suggestTags('ca')), ['card 3', 'carousel 3', 'cart 1'])
  assert.deepEqual(named(library.suggestTags('CA', { exclude: ['Carousel'] })), ['card 3', 'cart 1'])
  assert.deepEqual(named(library.suggestTags('c', { limit: 2 })), ['card 3', 'carousel 3'])
  assert.deepEqual(named(library.suggestTags('')), ['card 3', 'carousel 3', 'CTA 2', 'dark 2', 'cart 1'])
  assert.deepEqual(named(library.suggestTags('ｃａ')), ['card 3', 'carousel 3', 'cart 1'], 'full-width input folds')
  library.close()
})

test('CX-p1-find: text, tags and paging over live items', async () => {
  const { dir, open } = fresh()
  const library = await open()
  const a = await save(library, 'a', ['button'], '漸層按鈕很細緻')
  const b = await save(library, 'b', ['button'], 'button gradient')
  await save(library, 'c', ['card'], '卡片陰影')
  const gone = await save(library, 'd', [], '漸層')
  rawDb(dir, (db) => db.prepare('UPDATE items SET deleted_at = 1 WHERE id = ?').run(gone.item.id))

  const ids = (query: Parameters<Library['find']>[0]) => library.find(query).items.map((i) => i.id)
  assert.deepEqual(ids({ text: '漸層' }), [a.item.id])
  assert.deepEqual(ids({ text: '按鈕很' }), [a.item.id])
  assert.deepEqual(ids({ text: 'GRADIENT', tags: ['button'] }), [b.item.id])
  assert.deepEqual(ids({ text: 'Board' }).length, 3, 'page titles match too')
  assert.deepEqual(ids({ tags: ['button', 'card'] }), [])
  library.close()

  const paging = fresh()
  const many = await paging.open()
  const saved: string[] = []
  for (let i = 0; i < 30; i++) saved.push((await save(many, `page-${i}`, [])).item.id)
  const pages: string[][] = []
  let page = many.find({ limit: 10 })
  for (;;) {
    pages.push(page.items.map((i) => i.id))
    if (!page.next) break
    page = many.find({ limit: 10, before: page.next })
  }
  assert.deepEqual(pages.map((p) => p.length), [10, 10, 10])
  assert.deepEqual(pages.flat(), saved.reverse())
  many.close()
})

test('editing replaces tags and note, keeps a known spelling, and leaves other items alone', async () => {
  const { open } = fresh()
  const library = await open()
  const a = await save(library, 'a', ['Hero', 'dark'], 'first')
  const b = await save(library, 'b', ['dark'])
  const named = () => library.tags().map((t) => `${t.name} ${t.uses}`)
  assert.deepEqual(named(), ['dark 2', 'hero 1'])

  const edited = library.update(a.item.id, { tags: ['Hero', ' Gradient ', 'gradient', 'a,b'] })
  assert.deepEqual(edited?.tags, ['gradient', 'hero'], 'normalized and deduped by key')
  assert.equal(edited?.note, 'first', 'a patch without a note keeps it')
  assert.ok(edited!.updatedAt >= a.item.updatedAt)
  assert.deepEqual(named(), ['dark 1', 'gradient 1', 'hero 1'])
  assert.deepEqual(library.get(b.item.id)?.tags, ['dark'])

  assert.equal(library.update(a.item.id, { note: '為什麼好' })?.note, '為什麼好')
  assert.deepEqual(library.get(a.item.id)?.tags, ['gradient', 'hero'], 'a patch without tags keeps them')
  assert.deepEqual(library.find({ text: '為什麼' }).items.map((i) => i.id), [a.item.id], 'the new note is searchable')

  assert.deepEqual(library.update(a.item.id, { tags: ['dark'] })?.tags, ['dark'], 'a tag taken off comes back on')
  assert.deepEqual(library.update(a.item.id, { tags: ['CTA'] })?.tags, ['CTA'])
  assert.deepEqual(library.update(b.item.id, { tags: ['cta'] })?.tags, ['CTA'], 'the existing spelling kept')
  library.close()
})

test('a removed item leaves every read, keeps its files, and the same bytes saved again are a new item', async () => {
  const { dir, open } = fresh()
  const library = await open()
  const kept = await save(library, 'kept', ['shared'])
  const gone = await save(library, 'gone', ['shared', 'only'])
  const files = filesUnder(join(dir, 'blobs')).length

  assert.equal(library.remove(gone.item.id), true)
  assert.equal(library.remove(gone.item.id), false, 'removing twice is a no-op')
  assert.equal(library.get(gone.item.id), null)
  assert.equal(library.update(gone.item.id, { note: 'x' }), null)
  assert.deepEqual(library.find({}).items.map((i) => i.id), [kept.item.id])
  assert.deepEqual(library.tags().map((t) => `${t.name} ${t.uses}`), ['shared 1'])
  assert.equal(filesUnder(join(dir, 'blobs')).length, files)

  const again = await save(library, 'gone', [])
  assert.equal(again.merged, false)
  assert.notEqual(again.item.id, gone.item.id)
  assert.ok(existsSync(again.item.content.type === 'file' ? again.item.content.path : ''))
  library.close()
})

test('a library written by an incompatible schema epoch refuses to open', async () => {
  const { dir, open } = fresh()
  ;(await open()).close()
  rawDb(dir, (db) => db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_epoch'").run())
  await assert.rejects(open(), (e: unknown) => e instanceof LibraryError && e.code === 'schema-newer')
})

test('a newer additive version of the same epoch still opens', async () => {
  const { dir, open } = fresh()
  ;(await open()).close()
  rawDb(dir, (db) => db.exec('PRAGMA user_version = 7'))
  const library = await open()
  assert.equal(library.find({}).items.length, 0)
  library.close()
})

test('a library from before tag initials were lowercased has its tags renamed on open', async () => {
  const { dir, open } = fresh()
  const before = await open()
  const saved = await save(before, 'a', ['hero', 'CTA'])
  before.close()
  rawDb(dir, (db) => {
    db.prepare("UPDATE tags SET name = 'Hero' WHERE key = 'hero'").run()
    db.exec('PRAGMA user_version = 1')
  })
  const library = await open()
  assert.deepEqual(library.get(saved.item.id)?.tags, ['CTA', 'hero'])
  library.close()
})

test('ids made in one millisecond still sort in creation order', () => {
  const ids = Array.from({ length: 1000 }, () => ulid(Date.UTC(2100, 0, 1)))
  assert.deepEqual([...ids].sort(), ids)
  assert.equal(new Set(ids).size, 1000)
  assert.deepEqual(new Set(ids.map((id) => id.slice(0, 10))), new Set(['03QCPC7P00']))
})
