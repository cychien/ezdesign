/** The library as the shell reads it. Types only, so the shell bundles it.
 *
 *      GET    /library/items?q=&tag=&before=   -> LibraryPageWire
 *      GET    /library/tags                    -> {tags: LibraryTagWire[]}
 *      GET    /library/items/:id/thumbnail     -> the WebP thumbnail
 *      GET    /library/items/:id/original      -> the file, or a link's frame
 *      PATCH  /library/items/:id  LibraryPatchWire -> LibraryItemWire
 *      DELETE /library/items/:id               -> {ok: true}
 *
 *  Errors are `{error, code}`; `code` is `not-found`, `bad-request`, or a
 *  `LibraryErrorCode` when the library cannot open (503). */

export type LibraryKindWire = 'image' | 'screenshot' | 'video'

export interface LibraryItemWire {
  id: string
  kind: LibraryKindWire
  /** The stored bytes: the file itself, or a link item's full-size frame. */
  original: { url: string; mediaType: string; bytes: number } | null
  /** Set when the item keeps a link instead of its video. */
  link: { reason: 'stream' | 'too-large'; playbackTime: number | null } | null
  thumbnail: { url: string; width: number; height: number } | null
  dimensions: { width: number; height: number } | null
  source: { pageUrl: string; pageTitle: string; mediaUrl: string | null; capturedAt: number }
  tags: string[]
  note: string
  createdAt: number
  updatedAt: number
}

export interface LibraryPageWire {
  /** Newest first. */
  items: LibraryItemWire[]
  /** Pass as `before` for the next page. */
  next: string | null
}

export interface LibraryTagWire {
  name: string
  uses: number
}

/** Fields left out are kept; `tags` replaces the item's. */
export interface LibraryPatchWire {
  tags?: string[]
  note?: string
}
