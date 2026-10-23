import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { type CommitResult, openLibrary } from '../src/library/index.js'
import type { LibraryItemWire, LibraryPageWire, LibraryTagWire } from '../src/library-wire.js'
import { DaemonWorld } from './helpers/daemon.js'
import { png, webp } from './helpers/media.js'

const world = await DaemonWorld.create()
let api = ''
let origin = ''
const saved: CommitResult[] = []

async function save(seed: string, tags: string[], note: string, pageTitle: string, svg = false): Promise<CommitResult> {
  const library = await openLibrary({ dir: join(world.dataDir, 'library') })
  try {
    const bytes = svg ? Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`) : png(20, 10, 64, seed)
    const stage = library.stage({
      kind: 'image',
      source: { pageUrl: `https://ref.test/${seed}`, pageTitle, mediaUrl: null, capturedAt: 1 },
    })
    await stage.write(bytes)
    const ready = await stage.finish({ sha256: createHash('sha256').update(bytes).digest('hex') })
    await ready.setThumbnail({ webp: webp(20, 10), width: 20, height: 10, source: { width: 20, height: 10 } })
    return await ready.commit({ tags, note })
  } finally {
    library.close()
  }
}

const json = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const res = await fetch(api + path, init)
  return { status: res.status, body: (await res.json()) as T }
}

before(async () => {
  saved.push(await save('a', ['Hero', 'dark'], '漸層很細緻', 'Linear'))
  saved.push(await save('b', ['dark'], '', 'Vercel'))
  world.spawnDaemon()
  const { port } = await world.liveDaemon()
  const { shellUrl } = await world.openSession(port, { project: mkdtempSync(join(world.dataDir, 'project-')) })
  origin = new URL(shellUrl).origin
  api = `${origin}/__ezdesign/api`
})

after(() => world.dispose())

test('the shell lists the library newest first, with every tag, and filters by text and tag', async () => {
  const page = await json<LibraryPageWire>('/library/items')
  assert.equal(page.status, 200)
  assert.deepEqual(page.body.items.map((i) => i.id), [saved[1]!.item.id, saved[0]!.item.id])
  assert.equal(page.body.next, null)
  const first = page.body.items[1]!
  assert.deepEqual(first.tags, ['dark', 'Hero'])
  assert.equal(first.source.pageTitle, 'Linear')
  assert.deepEqual(first.dimensions, { width: 20, height: 10 })

  const tags = await json<{ tags: LibraryTagWire[] }>('/library/tags')
  assert.deepEqual(tags.body.tags, [
    { name: 'dark', uses: 2 },
    { name: 'Hero', uses: 1 },
  ])

  const ids = async (query: string) => (await json<LibraryPageWire>(`/library/items?${query}`)).body.items.map((i) => i.id)
  assert.deepEqual(await ids('q=漸層'), [saved[0]!.item.id])
  assert.deepEqual(await ids('tag=hero'), [saved[0]!.item.id])
  assert.deepEqual(await ids('tag=dark&tag=Hero'), [saved[0]!.item.id])
  assert.deepEqual(await ids('q=Vercel&tag=Hero'), [])
})

test('thumbnails and originals are served as their bytes, cacheable by their content url', async () => {
  const item = (await json<LibraryPageWire>('/library/items')).body.items[1]!
  const thumb = await fetch(origin + item.thumbnail!.url)
  assert.equal(thumb.status, 200)
  assert.equal(thumb.headers.get('content-type'), 'image/webp')
  assert.match(thumb.headers.get('cache-control') ?? '', /immutable/)
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), webp(20, 10))

  const original = await fetch(origin + item.original!.url)
  assert.equal(original.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), png(20, 10, 64, 'a'))

  assert.equal((await fetch(`${api}/library/items/01J00000000000000000000000/original`)).status, 404)
  assert.equal((await fetch(`${api}/library/items/..%2F..%2Fdaemon.json/original`)).status, 404)
})

test('a saved SVG cannot run script on the session origin', async () => {
  const svg = await save('svg', [], '', 'Icons', true)
  const res = await fetch(`${api}/library/items/${svg.item.id}/original`)
  assert.equal(res.headers.get('content-type'), 'image/svg+xml')
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await fetch(`${api}/library/items/${svg.item.id}`, { method: 'DELETE' })).status, 200)
})

test('editing tags and the note writes through, and a deleted item is gone from every read', async () => {
  const id = saved[1]!.item.id
  const patch = (body: unknown) =>
    json<LibraryItemWire & { code?: string }>(`/library/items/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const edited = await patch({ tags: ['dark', 'Minimal'], note: '留白' })
  assert.equal(edited.status, 200)
  assert.deepEqual(edited.body.tags, ['dark', 'Minimal'])
  assert.equal(edited.body.note, '留白')
  assert.equal((await patch({ tags: 'dark' })).status, 400)
  assert.equal((await patch({})).status, 400)

  assert.equal((await fetch(`${api}/library/items/${id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await fetch(`${api}/library/items/${id}`, { method: 'DELETE' })).status, 404)
  assert.equal((await patch({ note: 'x' })).status, 404)
  const page = await json<LibraryPageWire>('/library/items')
  assert.deepEqual(page.body.items.map((i) => i.id), [saved[0]!.item.id])
  const tags = await json<{ tags: LibraryTagWire[] }>('/library/tags')
  assert.deepEqual(tags.body.tags.map((t) => t.name), ['dark', 'Hero'])
})

test('another site cannot read or change the library', async () => {
  const id = saved[0]!.item.id
  const res = await fetch(`${api}/library/items/${id}`, { method: 'DELETE', headers: { origin: 'https://evil.test' } })
  assert.equal(res.status, 403)
  assert.equal((await fetch(`${api}/library/items`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
})
