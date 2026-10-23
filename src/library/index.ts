import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { libraryDir } from '../constants.js'
import { LibraryError, asLibraryError } from './internal/errors.js'
import {
  type LibraryPaths,
  type SniffedType,
  type StagedFile,
  type StagingArea,
  claimStaging,
  contentPath,
  libraryPaths,
  placeContent,
  sniffMediaType,
  sweepDeadStaging,
} from './internal/files.js'
import { pngSize, webpSize } from './internal/image-size.js'
import { type BlobRecord, type ItemRecord, type Store, loadSqlite, openStore } from './internal/store.js'
import { ulid } from './internal/ulid.js'
import { THUMBNAIL_LONG_SIDE, VIDEO_CAP_BYTES, normalizeTag, tagKey } from './policy.js'

export { LibraryError, type LibraryErrorCode } from './internal/errors.js'
export { THUMBNAIL_LONG_SIDE, VIDEO_CAP_BYTES, normalizeTag, tagKey, thumbnailSize } from './policy.js'
export type { TagName } from './policy.js'

declare const itemBrand: unique symbol
/** A ULID: sortable by creation. */
export type ItemId = string & { readonly [itemBrand]: 'ItemId' }
declare const shaBrand: unique symbol
export type Sha256 = string & { readonly [shaBrand]: 'Sha256' }

export type CaptureKind = 'image' | 'screenshot' | 'video'
/** Why an item holds a link instead of its bytes: a stream has nothing to
 *  download; a video over `VIDEO_CAP_BYTES` is not stored. */
export type LinkReason = 'stream' | 'too-large'

export interface Dimensions {
  width: number
  height: number
}

/** Times are epoch ms throughout. */
export interface CaptureSource {
  pageUrl: string
  pageTitle: string
  mediaUrl: string | null
  capturedAt: number
}

export interface StoredFile {
  path: string
  sha256: Sha256
  mediaType: string
  bytes: number
}

export type ItemContent =
  | ({ type: 'file' } & StoredFile)
  | {
      type: 'link'
      reason: LinkReason
      /** What the video would have taken, for `too-large`. */
      bytes: number | null
      playbackTime: number | null
      /** The frame captured with the link, at full size (a PNG). */
      frame: StoredFile | null
    }

export interface Thumbnail {
  path: string
  sha256: Sha256
  width: number
  height: number
}

export interface Item {
  id: ItemId
  kind: CaptureKind
  content: ItemContent
  source: CaptureSource
  /** Pixel size of the original (or of the frame, for a video). */
  dimensions: Dimensions | null
  thumbnail: Thumbnail | null
  /** Display spellings, one per tag key, in key order. */
  tags: readonly string[]
  note: string
  createdAt: number
  updatedAt: number
}

export interface StageRequest {
  kind: CaptureKind
  source: CaptureSource
  /** A size the producer already knows (Content-Length, an upload's declared
   *  size). A video over the cap is over it before the first byte. */
  expectedBytes?: number
}

export interface LinkStageRequest {
  kind: 'video'
  source: CaptureSource
  playbackTime: number | null
}

/** `over-cap`: a video crossed `VIDEO_CAP_BYTES`. The stage dropped what it had
 *  and will finish as a `too-large` link; the producer should stop sending. */
export type WriteOutcome = 'accepted' | 'over-cap'

export interface ReceivingStage {
  readonly state: 'receiving'
  readonly bytesWritten: number
  /** Appends in order. */
  write(chunk: Uint8Array): Promise<WriteOutcome>
  /** Seals the bytes, sniffs the media type and looks the hash up. With
   *  `sha256`, a mismatch discards the stage and throws `integrity`. */
  finish(expect?: { sha256?: string }): Promise<ReadyStage>
  discard(): Promise<void>
}

interface ReadyStageBase {
  readonly state: 'ready'
  /** The live item holding the same bytes, if any. Committing then
   *  merges into it instead of adding a second item. */
  readonly duplicateOf: Item | null
  /** Replaces any earlier one. Rejects anything but a WebP whose header says
   *  `width` x `height`, with a long side of at most `THUMBNAIL_LONG_SIDE`. */
  setThumbnail(thumbnail: ThumbnailInput): Promise<void>
  /** Idempotent: a second call resolves to the first call's result. A failed
   *  call (a busy db, a full disk) can be retried. */
  commit(input: CommitInput): Promise<CommitResult>
  /** Idempotent, and a no-op after a commit. */
  discard(): Promise<void>
}

export interface ReadyFileStage extends ReadyStageBase {
  readonly type: 'file'
  readonly file: { sha256: Sha256; mediaType: string; bytes: number }
  /** The staged bytes in pieces of at most `chunkBytes`. */
  read(chunkBytes: number): AsyncIterable<Uint8Array>
}

export interface ReadyLinkStage extends ReadyStageBase {
  readonly type: 'link'
  readonly link: { reason: LinkReason; bytes: number | null }
  /** The frame the link keeps, a full-size PNG; replaces any earlier one. Its
   *  size becomes the item's dimensions. */
  attachFrame(png: Uint8Array): Promise<void>
}

export type ReadyStage = ReadyFileStage | ReadyLinkStage

export interface ThumbnailInput {
  webp: Uint8Array
  width: number
  height: number
  /** Pixel size of what it was made from; recorded as the item's dimensions. */
  source: Dimensions
}

export interface CommitInput {
  /** Raw spellings. Normalized here; invalid ones are dropped, duplicates by
   *  key collapse to the first spelling. */
  tags: readonly string[]
  note: string
}

/** On a duplicate (`merged`), the submitted tags are added to the item's (never
 *  removed), and a non-empty note that differs is appended after a blank line. */
export interface CommitResult {
  item: Item
  merged: boolean
}

/** Fields left out are kept. */
export interface ItemPatch {
  /** Replaces the item's tags; normalized like `CommitInput.tags`. */
  tags?: readonly string[]
  note?: string
}

export interface TagUse {
  name: string
  /** Live items carrying the tag. */
  uses: number
}

export interface SuggestOptions {
  /** Tags already chosen, by any spelling. */
  exclude?: readonly string[]
  limit?: number
}

declare const cursorBrand: unique symbol
export type ItemCursor = string & { readonly [cursorBrand]: 'ItemCursor' }

export interface ItemQuery {
  /** Matched against notes and page titles. */
  text?: string
  /** Every one of these, compared by key. */
  tags?: readonly string[]
  limit?: number
  before?: ItemCursor
}

export interface ItemPage {
  /** Newest first. */
  items: Item[]
  next: ItemCursor | null
}

export interface Library {
  /** Absolute; what `openLibrary` resolved. */
  readonly dir: string
  stage(request: StageRequest): ReceivingStage
  stageLink(request: LinkStageRequest): ReadyLinkStage
  /** Tags whose key starts with `prefix`'s key, most used first, then by key.
   *  An empty prefix lists the most used. */
  suggestTags(prefix: string, options?: SuggestOptions): TagUse[]
  /** Every tag a live item carries, most used first, then by key. */
  tags(): TagUse[]
  get(id: ItemId): Item | null
  find(query: ItemQuery): ItemPage
  /** Null when there is no live item `id`. */
  update(id: ItemId, patch: ItemPatch): Item | null
  /** A tombstone: the item leaves every read, its files stay. False when there
   *  was no live item `id`. */
  remove(id: ItemId): boolean
  /** Discards this handle's open stages and closes the db. */
  close(): void
}

export interface OpenLibraryOptions {
  /** Default: `libraryDir()`, i.e. `<data dir>/library`, resolved per call. */
  dir?: string
}

const SUGGEST_LIMIT = 8
const FIND_LIMIT = 50
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(value)))

/** Creates the layout if missing, migrates the schema, and sweeps the stages
 *  of processes that died. Safe to call from several processes at once. */
export async function openLibrary(options: OpenLibraryOptions = {}): Promise<Library> {
  const paths = libraryPaths(resolve(options.dir ?? libraryDir()))
  const sqlite = await loadSqlite()
  ensureLayout(paths)
  const store = await openStore(sqlite, paths.db)
  try {
    sweepDeadStaging(paths)
    return new LocalLibrary(paths, store, claimStaging(paths))
  } catch (error) {
    store.close()
    throw asLibraryError(error)
  }
}

function ensureLayout(paths: LibraryPaths): void {
  try {
    for (const dir of [paths.root, paths.blobs, paths.thumbs, paths.staging]) mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw asLibraryError(error)
  }
}

class LocalLibrary implements Library {
  readonly open = new Set<Stage>()
  private closed = false

  constructor(
    readonly paths: LibraryPaths,
    readonly store: Store,
    private readonly staging: StagingArea,
  ) {}

  get dir(): string {
    return this.paths.root
  }

  stage(request: StageRequest): ReceivingStage {
    return this.track(new Stage(this, request, this.staging.create(), null)) as ReceivingStage
  }

  stageLink(request: LinkStageRequest): ReadyLinkStage {
    const link = { reason: 'stream' as const, bytes: null, playbackTime: request.playbackTime }
    return this.track(new Stage(this, request, this.staging.create(), link)) as ReadyLinkStage
  }

  suggestTags(prefix: string, options: SuggestOptions = {}): TagUse[] {
    this.assertOpen()
    const limit = clamp(options.limit ?? SUGGEST_LIMIT, 1, 50)
    return this.store.suggestTags(tagKey(prefix), (options.exclude ?? []).map(tagKey), limit)
  }

  tags(): TagUse[] {
    this.assertOpen()
    return this.store.tags()
  }

  update(id: ItemId, patch: ItemPatch): Item | null {
    this.assertOpen()
    try {
      const found = this.store.updateItem(id, {
        note: patch.note,
        tags: patch.tags && uniqueTags(patch.tags),
        now: Date.now(),
      })
      return found ? this.get(id) : null
    } catch (error) {
      throw asLibraryError(error)
    }
  }

  remove(id: ItemId): boolean {
    this.assertOpen()
    try {
      return this.store.removeItem(id, Date.now())
    } catch (error) {
      throw asLibraryError(error)
    }
  }

  get(id: ItemId): Item | null {
    this.assertOpen()
    const record = this.store.item(id)
    return record ? this.toItem(record) : null
  }

  find(query: ItemQuery): ItemPage {
    this.assertOpen()
    const limit = clamp(query.limit ?? FIND_LIMIT, 1, 500)
    const records = this.store.find({
      text: query.text?.trim() ? query.text.trim() : null,
      tagKeys: [...new Set((query.tags ?? []).map(tagKey))],
      limit: limit + 1,
      beforeId: query.before ?? null,
    })
    const items = records.slice(0, limit).map((r) => this.toItem(r))
    const next = records.length > limit ? (items[items.length - 1]!.id as string as ItemCursor) : null
    return { items, next }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const stage of [...this.open]) stage.abandon()
    this.staging.release()
    this.store.close()
  }

  assertOpen(): void {
    if (this.closed) throw new LibraryError('stage-closed', 'The library was closed')
  }

  toItem(record: ItemRecord): Item {
    const stored = (blob: BlobRecord): StoredFile => ({
      path: contentPath(this.paths.blobs, blob.sha256, blob.ext),
      sha256: blob.sha256 as Sha256,
      mediaType: blob.mediaType,
      bytes: blob.bytes,
    })
    const content: ItemContent = record.link
      ? { type: 'link', ...record.link, frame: record.blob ? stored(record.blob) : null }
      : { type: 'file', ...stored(record.blob!) }
    return {
      id: record.id as ItemId,
      kind: record.kind,
      content,
      source: {
        pageUrl: record.pageUrl,
        pageTitle: record.pageTitle,
        mediaUrl: record.mediaUrl,
        capturedAt: record.capturedAt,
      },
      dimensions: record.width !== null && record.height !== null ? { width: record.width, height: record.height } : null,
      thumbnail: record.thumbnail && {
        path: contentPath(this.paths.thumbs, record.thumbnail.sha256, 'webp'),
        sha256: record.thumbnail.sha256 as Sha256,
        width: record.thumbnail.width,
        height: record.thumbnail.height,
      },
      tags: record.tags,
      note: record.note,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  private track(stage: Stage): Stage {
    this.assertOpen()
    this.open.add(stage)
    return stage
  }
}

function acceptsMedia(kind: CaptureKind, sniffed: SniffedType): boolean {
  return sniffed.mediaType.startsWith(kind === 'video' ? 'video/' : 'image/')
}

function uniqueTags(raw: readonly string[]): [name: string, key: string][] {
  const byKey = new Map<string, string>()
  for (const spelling of raw) {
    const name = normalizeTag(spelling)
    if (name !== null && !byKey.has(tagKey(name))) byKey.set(tagKey(name), name)
  }
  return [...byKey].map(([key, name]) => [name, key])
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

interface StagedThumbnail {
  sha256: string
  width: number
  height: number
  source: Dimensions
}

interface StagedFrame {
  sha256: string
  bytes: number
  size: Dimensions
}

class Stage {
  state: 'receiving' | 'ready' = 'receiving'
  type: 'file' | 'link' = 'file'
  file: { sha256: Sha256; mediaType: string; bytes: number } | null = null
  link: { reason: LinkReason; bytes: number | null } | null = null
  duplicateOf: Item | null = null

  private ext = ''
  private playbackTime: number | null = null
  private overCap = false
  private bytesOffered = 0
  private thumbnail: StagedThumbnail | null = null
  private frame: StagedFrame | null = null
  private writing: Promise<unknown> = Promise.resolve()
  private ended: 'committed' | 'discarded' | null = null
  private committing: Promise<CommitResult> | null = null

  constructor(
    private readonly library: LocalLibrary,
    private readonly request: StageRequest | LinkStageRequest,
    private readonly staged: StagedFile,
    link: { reason: LinkReason; bytes: number | null; playbackTime: number | null } | null,
  ) {
    if (link) {
      this.state = 'ready'
      this.type = 'link'
      this.link = { reason: link.reason, bytes: link.bytes }
      this.playbackTime = link.playbackTime
    } else if (request.kind === 'video' && ((request as StageRequest).expectedBytes ?? 0) > VIDEO_CAP_BYTES) {
      this.overCap = true
    }
  }

  get bytesWritten(): number {
    return this.staged.bytes
  }

  write(chunk: Uint8Array): Promise<WriteOutcome> {
    const next = this.writing.then(() => this.writeNow(chunk))
    this.writing = next.catch(() => {})
    return next
  }

  private async writeNow(chunk: Uint8Array): Promise<WriteOutcome> {
    this.assertLive('receiving')
    this.bytesOffered += chunk.length
    if (this.overCap) return 'over-cap'
    if (this.request.kind === 'video' && this.staged.bytes + chunk.length > VIDEO_CAP_BYTES) {
      this.overCap = true
      this.staged.remove()
      return 'over-cap'
    }
    try {
      await this.staged.append(chunk)
    } catch (error) {
      throw asLibraryError(error)
    }
    return 'accepted'
  }

  async finish(expect: { sha256?: string } = {}): Promise<ReadyStage> {
    await this.writing
    this.assertLive('receiving')
    if (this.overCap) {
      this.staged.remove()
      const expected = (this.request as StageRequest).expectedBytes ?? 0
      this.type = 'link'
      this.link = { reason: 'too-large', bytes: Math.max(expected, this.bytesOffered) }
      this.state = 'ready'
      return this as unknown as ReadyStage
    }
    let sha256: string
    try {
      sha256 = await this.staged.seal()
    } catch (error) {
      this.abandon()
      throw asLibraryError(error)
    }
    if (expect.sha256 !== undefined && expect.sha256 !== sha256) {
      this.abandon()
      throw new LibraryError('integrity', `The staged bytes hash to ${sha256}, not ${expect.sha256}`)
    }
    const sniffed = sniffMediaType(this.staged.head)
    if (!sniffed || !acceptsMedia(this.request.kind, sniffed)) {
      this.abandon()
      throw new LibraryError(
        'unsupported-media',
        `The bytes are ${sniffed?.mediaType ?? 'not a known media type'}, not ${this.request.kind === 'video' ? 'a video' : 'an image'}`,
      )
    }
    this.ext = sniffed.ext
    this.file = { sha256: sha256 as Sha256, mediaType: sniffed.mediaType, bytes: this.staged.bytes }
    const duplicate = this.library.store.liveFileItemByBlob(sha256)
    this.duplicateOf = duplicate && this.library.toItem(duplicate)
    this.state = 'ready'
    return this as unknown as ReadyStage
  }

  async setThumbnail(thumbnail: ThumbnailInput): Promise<void> {
    this.assertLive('ready')
    const size = webpSize(thumbnail.webp)
    if (!size) throw new LibraryError('integrity', 'A thumbnail must be a WebP')
    if (size.width !== thumbnail.width || size.height !== thumbnail.height) {
      throw new LibraryError(
        'integrity',
        `The thumbnail is ${size.width}x${size.height}, not the ${thumbnail.width}x${thumbnail.height} it claims`,
      )
    }
    if (Math.max(size.width, size.height) > THUMBNAIL_LONG_SIDE) {
      throw new LibraryError('integrity', `A thumbnail's long side is at most ${THUMBNAIL_LONG_SIDE} px`)
    }
    this.writeStaged(this.staged.thumbPath, thumbnail.webp)
    this.thumbnail = { sha256: sha256Of(thumbnail.webp), ...size, source: { ...thumbnail.source } }
  }

  async attachFrame(png: Uint8Array): Promise<void> {
    this.assertLive('ready')
    if (this.type !== 'link') throw new LibraryError('integrity', 'Only a link keeps a frame')
    const size = pngSize(png)
    if (!size) throw new LibraryError('integrity', 'A frame must be a PNG')
    this.writeStaged(this.staged.framePath, png)
    this.frame = { sha256: sha256Of(png), bytes: png.length, size }
  }

  commit(input: CommitInput): Promise<CommitResult> {
    this.committing ??= this.commitOnce(input).catch((error: unknown) => {
      this.committing = null
      throw asLibraryError(error)
    })
    return this.committing
  }

  private async commitOnce(input: CommitInput): Promise<CommitResult> {
    this.assertLive('ready')
    const { paths, store } = this.library
    const duplicate = this.file ? store.liveFileItemByBlob(this.file.sha256) : null
    let blob: BlobRecord | null = null
    if (this.file) {
      placeContent(this.staged.sealedPath, contentPath(paths.blobs, this.file.sha256, this.ext))
      blob = { sha256: this.file.sha256, ext: this.ext, mediaType: this.file.mediaType, bytes: this.file.bytes }
    } else if (this.frame) {
      placeContent(this.staged.framePath, contentPath(paths.blobs, this.frame.sha256, 'png'))
      blob = { sha256: this.frame.sha256, ext: 'png', mediaType: 'image/png', bytes: this.frame.bytes }
    }
    const thumbnail = duplicate?.thumbnail ? null : this.thumbnail
    if (thumbnail) placeContent(this.staged.thumbPath, contentPath(paths.thumbs, thumbnail.sha256, 'webp'))
    const dimensions = this.frame?.size ?? this.thumbnail?.source ?? null
    const { id, merged } = store.commitItem({
      id: ulid(),
      kind: this.request.kind,
      blob,
      link: this.link && { ...this.link, playbackTime: this.playbackTime },
      thumbnail: thumbnail && { sha256: thumbnail.sha256, width: thumbnail.width, height: thumbnail.height },
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      pageUrl: this.request.source.pageUrl,
      pageTitle: this.request.source.pageTitle,
      mediaUrl: this.request.source.mediaUrl,
      note: input.note,
      capturedAt: this.request.source.capturedAt,
      tags: uniqueTags(input.tags),
      now: Date.now(),
    })
    this.ended = 'committed'
    this.release()
    return { item: this.library.get(id as ItemId)!, merged }
  }

  async discard(): Promise<void> {
    if (this.ended) return
    await this.writing
    this.abandon()
  }

  abandon(): void {
    if (this.ended) return
    this.ended = 'discarded'
    this.release()
  }

  async *read(chunkBytes: number): AsyncIterable<Uint8Array> {
    this.assertLive('ready')
    if (this.type !== 'file') throw new LibraryError('integrity', 'A link stage has no bytes to read')
    for await (const chunk of createReadStream(this.staged.sealedPath, { highWaterMark: chunkBytes })) {
      yield chunk as Buffer
    }
  }

  private release(): void {
    this.staged.remove()
    this.library.open.delete(this)
  }

  private writeStaged(path: string, bytes: Uint8Array): void {
    try {
      writeFileSync(path, bytes)
    } catch (error) {
      throw asLibraryError(error)
    }
  }

  private assertLive(state: 'receiving' | 'ready'): void {
    if (this.ended) throw new LibraryError('stage-closed', `The stage was ${this.ended}`)
    if (this.state !== state) throw new LibraryError('stage-closed', `The stage is ${this.state}, not ${state}`)
  }
}
