/** The shell's end of the capture library. The routes are listed in
 *  `library-wire.ts`; they sit on the api router, behind `refuseCrossSite`. */

import express, { type Request, type RequestHandler, type Response, Router } from 'express'
import { URL_PREFIX } from './constants.js'
import {
  type Item,
  type ItemCursor,
  type ItemId,
  type Library,
  LibraryError,
  type StoredFile,
  type ThumbnailInput,
} from './library/index.js'
import type { AttachmentOrigin } from './protocol.js'
import type {
  LibraryAddedWire,
  LibraryItemWire,
  LibraryPageWire,
  LibraryPasteMeta,
  LibraryPatchWire,
} from './library-wire.js'

export interface LibraryRouteHost {
  /** The daemon's one handle, opened on first use. */
  library(): Promise<Library>
}

const PAGE_LIMIT = 60
const MAX_TAGS = 100
const MAX_NOTE = 10_000
const ITEM_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const MAX_PASTE_BYTES = 64 * 1024 * 1024

const itemUrl = (id: string, file: 'thumbnail' | 'original', sha256: string) =>
  `${URL_PREFIX}/api/library/items/${id}/${file}?v=${sha256.slice(0, 16)}`

function storedOriginal(item: Item): StoredFile | null {
  return item.content.type === 'file' ? item.content : item.content.frame
}

/** What a composer attaches for a library item: its stored bytes (a link's
 *  frame) and where it came from. */
export interface LibraryAttachable {
  title: string
  file: StoredFile
  origin: Omit<AttachmentOrigin, 'pick'>
}

/** Every id resolved, in order, or the first one that cannot be: a partial answer
 *  would drop a reference the user watched themselves choose. */
export function libraryAttachables(
  library: Library,
  ids: readonly string[],
): { ok: LibraryAttachable[] } | { missing: string } {
  const ok: LibraryAttachable[] = []
  for (const id of ids) {
    const item = ITEM_ID.test(id) ? library.get(id as ItemId) : null
    const file = item && storedOriginal(item)
    if (!item || !file) return { missing: id }
    const { pageUrl, pageTitle, mediaUrl } = item.source
    ok.push({
      title: pageTitle || hostOf(pageUrl),
      file,
      origin: { libraryItemId: item.id, pageUrl, pageTitle, mediaUrl, note: item.note, tags: [...item.tags] },
    })
  }
  return { ok }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function itemWire(item: Item): LibraryItemWire {
  const original = storedOriginal(item)
  return {
    id: item.id,
    kind: item.kind,
    original: original && {
      url: itemUrl(item.id, 'original', original.sha256),
      mediaType: original.mediaType,
      bytes: original.bytes,
    },
    link:
      item.content.type === 'link' ? { reason: item.content.reason, playbackTime: item.content.playbackTime } : null,
    thumbnail: item.thumbnail && {
      url: itemUrl(item.id, 'thumbnail', item.thumbnail.sha256),
      width: item.thumbnail.width,
      height: item.thumbnail.height,
    },
    dimensions: item.dimensions,
    source: { ...item.source },
    tags: [...item.tags],
    note: item.note,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

export function parsePatch(raw: unknown): LibraryPatchWire | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { tags, note } = raw as Record<string, unknown>
  const patch: LibraryPatchWire = {}
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > MAX_TAGS || !tags.every((t) => typeof t === 'string')) return null
    patch.tags = tags
  }
  if (note !== undefined) {
    if (typeof note !== 'string' || note.length > MAX_NOTE) return null
    patch.note = note
  }
  return patch.tags || patch.note !== undefined ? patch : null
}

const isSize = (raw: unknown): raw is { width: number; height: number } => {
  const { width, height } = (raw ?? {}) as Record<string, unknown>
  return [width, height].every((n) => Number.isInteger(n) && (n as number) > 0)
}

/** Null for anything but an image file, a thumbnail and their sizes. */
export async function parsePaste(req: Request): Promise<{ original: Uint8Array; thumbnail: ThumbnailInput } | null> {
  if (!Buffer.isBuffer(req.body)) return null
  const form = await new Response(req.body as Uint8Array<ArrayBuffer>, { headers: { 'content-type': req.get('content-type') ?? '' } })
    .formData()
    .catch(() => null)
  const original = form?.get('original')
  const thumbnail = form?.get('thumbnail')
  const metaField = form?.get('meta')
  if (!(original instanceof Blob) || original.size === 0 || !(thumbnail instanceof Blob) || typeof metaField !== 'string') {
    return null
  }
  let meta: LibraryPasteMeta
  try {
    meta = JSON.parse(metaField) as LibraryPasteMeta
  } catch {
    return null
  }
  if (!isSize(meta?.thumbnail) || !isSize(meta.source)) return null
  return {
    original: new Uint8Array(await original.arrayBuffer()),
    thumbnail: {
      webp: new Uint8Array(await thumbnail.arrayBuffer()),
      width: meta.thumbnail.width,
      height: meta.thumbnail.height,
      source: { width: meta.source.width, height: meta.source.height },
    },
  }
}

async function savePasted(library: Library, paste: { original: Uint8Array; thumbnail: ThumbnailInput }) {
  const receiving = library.stage({
    kind: 'image',
    source: { pageUrl: '', pageTitle: '', mediaUrl: null, capturedAt: Date.now() },
  })
  try {
    await receiving.write(paste.original)
  } catch (error) {
    await receiving.discard()
    throw error
  }
  const ready = await receiving.finish()
  try {
    await ready.setThumbnail(paste.thumbnail)
    return await ready.commit({ tags: [], note: '' })
  } finally {
    await ready.discard()
  }
}

const queryList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v !== '')

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ error, code })
}

export function libraryApiRouter(host: LibraryRouteHost): Router {
  const router = Router()

  /** A library that cannot open (a node without sqlite, a newer schema) is the
   *  whole feature's answer, not a crash. */
  const withLibrary =
    (handle: (library: Library, ...args: Parameters<RequestHandler>) => void): RequestHandler =>
    (req, res, next) => {
      host.library().then(
        (library) => {
          try {
            handle(library, req, res, next)
          } catch (error) {
            if (!(error instanceof LibraryError)) return next(error)
            refuse(res, error.retryable ? 503 : 500, error.code, error.message)
          }
        },
        (error: unknown) => {
          if (error instanceof LibraryError) refuse(res, 503, error.code, error.message)
          else next(error)
        },
      )
    }

  const itemId = (raw: unknown): ItemId | null =>
    typeof raw === 'string' && ITEM_ID.test(raw) ? (raw as ItemId) : null

  router.get(
    '/library/items',
    withLibrary((library, req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined
      const page = library.find({
        text: q,
        tags: queryList(req.query.tag),
        limit: PAGE_LIMIT,
        before: (itemId(req.query.before) as string | null as ItemCursor | null) ?? undefined,
      })
      res.set('cache-control', 'no-store').json({ items: page.items.map(itemWire), next: page.next } satisfies LibraryPageWire)
    }),
  )

  router.get(
    '/library/tags',
    withLibrary((library, _req, res) => {
      res.set('cache-control', 'no-store').json({ tags: library.tags() })
    }),
  )

  for (const file of ['thumbnail', 'original'] as const) {
    router.get(
      `/library/items/:id/${file}`,
      withLibrary((library, req, res, next) => {
        const id = itemId(req.params.id)
        const item = id && library.get(id)
        const stored =
          file === 'thumbnail'
            ? item?.thumbnail && { path: item.thumbnail.path, mediaType: 'image/webp' }
            : item && storedOriginal(item)
        if (!stored) return refuse(res, 404, 'not-found', `no ${file} for ${req.params.id}`)
        res.sendFile(
          stored.path,
          {
            // The library lives under `~/.ezdesign`, which `send` would refuse as a dotfile path.
            dotfiles: 'allow',
            // Content-addressed: a url names its bytes for good.
            maxAge: req.query.v ? '1y' : 0,
            immutable: Boolean(req.query.v),
            headers: {
              'content-type': stored.mediaType,
              'x-content-type-options': 'nosniff',
              // A saved SVG opened on its own must not run on the session origin.
              'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            },
          },
          (error) => {
            if (error && !res.headersSent) refuse(res, 404, 'not-found', `the ${file} of ${req.params.id} is missing`)
            else if (error) next(error)
          },
        )
      }),
    )
  }

  router.post('/library/items', express.raw({ type: 'multipart/form-data', limit: MAX_PASTE_BYTES }), (req, res, next) => {
    void (async () => {
      const paste = await parsePaste(req)
      if (!paste) return refuse(res, 400, 'bad-request', 'a paste is a multipart form of original, thumbnail and meta')
      const { item, merged } = await savePasted(await host.library(), paste)
      res.status(merged ? 200 : 201).json({ item: itemWire(item), merged } satisfies LibraryAddedWire)
    })().catch((error: unknown) => {
      if (!(error instanceof LibraryError)) return next(error)
      const status = error.code === 'unsupported-media' ? 415 : error.code === 'integrity' ? 400 : error.retryable ? 503 : 500
      refuse(res, status, error.code, error.message)
    })
  })

  router.patch(
    '/library/items/:id',
    withLibrary((library, req, res) => {
      const patch = parsePatch(req.body)
      if (!patch) return refuse(res, 400, 'bad-request', 'a patch is {tags?: string[], note?: string}')
      const id = itemId(req.params.id)
      const item = id && library.update(id, patch)
      if (!item) return refuse(res, 404, 'not-found', `no item ${req.params.id}`)
      res.json(itemWire(item))
    }),
  )

  router.delete(
    '/library/items/:id',
    withLibrary((library, req, res) => {
      const id = itemId(req.params.id)
      if (!id || !library.remove(id)) return refuse(res, 404, 'not-found', `no item ${req.params.id}`)
      res.json({ ok: true })
    }),
  )

  return router
}

/** Opens on first use and keeps the handle; a failed open is tried again next time. */
export function lazyLibrary(open: () => Promise<Library>): () => Promise<Library> {
  let opening: Promise<Library> | null = null
  return () => {
    opening ??= open().catch((error: unknown) => {
      opening = null
      throw error
    })
    return opening
  }
}
