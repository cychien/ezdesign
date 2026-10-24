import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import { normalizeTag } from '../policy.js'
import { LibraryError, asLibraryError, isBusy } from './errors.js'
import { ulid } from './ulid.js'

export const SCHEMA = { epoch: 1, version: 2 } as const

export const NODE_FLOOR = '22.13.0'

/** `seq` is a real INTEGER PRIMARY KEY because FTS5 external content needs a
 *  rowid that VACUUM cannot renumber. */
const TRIGRAM_MIN_CHARS = 3

const MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

  CREATE TABLE items (
    seq           INTEGER PRIMARY KEY,
    id            TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL CHECK (kind IN ('image', 'screenshot', 'video')),
    blob_sha256   TEXT CHECK (blob_sha256 IS NULL OR length(blob_sha256) = 64),
    blob_ext      TEXT,
    media_type    TEXT,
    byte_size     INTEGER,
    link_reason   TEXT CHECK (link_reason IN ('stream', 'too-large')),
    link_bytes    INTEGER,
    playback_time REAL,
    width         INTEGER,
    height        INTEGER,
    thumb_sha256  TEXT,
    thumb_width   INTEGER,
    thumb_height  INTEGER,
    page_url      TEXT NOT NULL,
    page_title    TEXT NOT NULL,
    media_url     TEXT,
    note          TEXT NOT NULL DEFAULT '',
    captured_at   INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    deleted_at    INTEGER,
    rev           INTEGER NOT NULL DEFAULT 1,
    CHECK (link_reason IS NOT NULL OR blob_sha256 IS NOT NULL),
    CHECK ((blob_sha256 IS NULL) = (blob_ext IS NULL))
  ) STRICT;
  CREATE UNIQUE INDEX items_live_blob ON items (blob_sha256)
    WHERE blob_sha256 IS NOT NULL AND link_reason IS NULL AND deleted_at IS NULL;

  CREATE TABLE tags (
    seq        INTEGER PRIMARY KEY,
    id         TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    key        TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev        INTEGER NOT NULL DEFAULT 1
  ) STRICT;
  CREATE UNIQUE INDEX tags_live_key ON tags (key) WHERE deleted_at IS NULL;

  CREATE TABLE item_tags (
    item_id    TEXT NOT NULL REFERENCES items (id),
    tag_id     TEXT NOT NULL REFERENCES tags (id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev        INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (item_id, tag_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX item_tags_by_tag ON item_tags (tag_id, item_id) WHERE deleted_at IS NULL;

  -- Trigram, because unicode61 cannot split unspaced CJK; queries under
  -- three characters scan instead.
  CREATE VIRTUAL TABLE items_text USING fts5 (
    page_title, note, content = 'items', content_rowid = 'seq', tokenize = 'trigram'
  );
  CREATE TRIGGER items_text_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_text (rowid, page_title, note) VALUES (new.seq, new.page_title, new.note);
  END;
  CREATE TRIGGER items_text_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_text (items_text, rowid, page_title, note) VALUES ('delete', old.seq, old.page_title, old.note);
  END;
  CREATE TRIGGER items_text_au AFTER UPDATE OF page_title, note ON items BEGIN
    INSERT INTO items_text (items_text, rowid, page_title, note) VALUES ('delete', old.seq, old.page_title, old.note);
    INSERT INTO items_text (rowid, page_title, note) VALUES (new.seq, new.page_title, new.note);
  END;
  `,
  renormalizeTagNames,
]

function renormalizeTagNames(db: DatabaseSync): void {
  const rename = db.prepare('UPDATE tags SET name = ?, updated_at = ?, rev = rev + 1 WHERE id = ?')
  const now = Date.now()
  for (const { id, name } of db.prepare('SELECT id, name FROM tags').all() as { id: string; name: string }[]) {
    const normalized = normalizeTag(name)
    if (normalized !== null && normalized !== name) rename.run(normalized, now, id)
  }
}

export type ItemKind = 'image' | 'screenshot' | 'video'
export type LinkReason = 'stream' | 'too-large'

export interface BlobRecord {
  sha256: string
  ext: string
  mediaType: string
  bytes: number
}

export interface ItemRecord {
  id: string
  kind: ItemKind
  blob: BlobRecord | null
  link: { reason: LinkReason; bytes: number | null; playbackTime: number | null } | null
  thumbnail: { sha256: string; width: number; height: number } | null
  width: number | null
  height: number | null
  pageUrl: string
  pageTitle: string
  mediaUrl: string | null
  note: string
  tags: string[]
  capturedAt: number
  createdAt: number
  updatedAt: number
}

export type CommitRecord = Omit<ItemRecord, 'createdAt' | 'updatedAt' | 'tags'> & {
  tags: readonly (readonly [name: string, key: string])[]
  now: number
}

export interface FindRecordQuery {
  text: string | null
  tagKeys: readonly string[]
  limit: number
  beforeId: string | null
}

export interface ItemPatchRecord {
  note?: string
  /** Replaces the item's tags. */
  tags?: readonly (readonly [name: string, key: string])[]
  now: number
}

export interface Store {
  liveFileItemByBlob(sha256: string): ItemRecord | null
  item(id: string): ItemRecord | null
  commitItem(record: CommitRecord): { id: string; merged: boolean }
  /** False when there is no live item `id`. */
  updateItem(id: string, patch: ItemPatchRecord): boolean
  removeItem(id: string, now: number): boolean
  suggestTags(prefixKey: string, excludeKeys: readonly string[], limit: number): { name: string; uses: number }[]
  tags(): { name: string; uses: number }[]
  find(query: FindRecordQuery): ItemRecord[]
  close(): void
}

function atLeast(version: string, floor: string): boolean {
  const [a, b] = [version, floor].map((v) => v.replace(/^v/, '').split('.').map(Number))
  for (let i = 0; i < 3; i++) {
    if ((a![i] ?? 0) !== (b![i] ?? 0)) return (a![i] ?? 0) > (b![i] ?? 0)
  }
  return true
}

export type Sqlite = typeof import('node:sqlite')

export async function loadSqlite(): Promise<Sqlite> {
  const tooOld = new LibraryError(
    'node-too-old',
    `Node ${process.version} cannot open the ezdesign library: it needs Node ${NODE_FLOOR.replace(/\.0$/, '')} or newer (node:sqlite)`,
  )
  if (!atLeast(process.versions.node, NODE_FLOOR)) throw tooOld
  try {
    return await import('node:sqlite')
  } catch {
    throw tooOld
  }
}

export async function openStore(sqlite: Sqlite, file: string): Promise<Store> {
  let db: DatabaseSync | null = null
  try {
    db = new sqlite.DatabaseSync(file)
    // By pragma, not the `timeout` option, which needs Node 22.16.
    db.exec('PRAGMA busy_timeout = 5000')
    const opened = db
    await patiently(() => opened.exec('PRAGMA journal_mode = WAL'))
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA synchronous = NORMAL')
    await patiently(() => migrate(opened))
    return new SqliteStore(db)
  } catch (error) {
    db?.close()
    throw asLibraryError(error)
  }
}

const OPEN_PATIENCE_MS = 5000

/** Switching a fresh db to WAL, and the first read of one another process is
 *  still creating, answer SQLITE_BUSY without consulting `busy_timeout`, so
 *  opening waits out a concurrent opener here. */
async function patiently<T>(step: () => T): Promise<T> {
  const deadline = Date.now() + OPEN_PATIENCE_MS
  for (;;) {
    try {
      return step()
    } catch (error) {
      if (!isBusy(error) || Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40))
    }
  }
}

function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > 0) {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_epoch'").get() as { value: string } | undefined
      if (Number(row?.value) !== SCHEMA.epoch) {
        throw new LibraryError(
          'schema-newer',
          'The ezdesign library was written by a newer, incompatible ezdesign; update ezdesign to open it',
        )
      }
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      const migration = MIGRATIONS[v]!
      if (typeof migration === 'string') db.exec(migration)
      else migration(db)
    }
    if (version < MIGRATIONS.length) {
      db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_epoch', ?)").run(String(SCHEMA.epoch))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

interface ItemRow {
  id: string
  kind: ItemKind
  blob_sha256: string | null
  blob_ext: string | null
  media_type: string | null
  byte_size: number | null
  link_reason: LinkReason | null
  link_bytes: number | null
  playback_time: number | null
  width: number | null
  height: number | null
  thumb_sha256: string | null
  thumb_width: number | null
  thumb_height: number | null
  page_url: string
  page_title: string
  media_url: string | null
  note: string
  captured_at: number
  created_at: number
  updated_at: number
  tag_names: string | null
}

const LIVE_TAG_NAMES = `(
  SELECT json_group_array(name) FROM (
    SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
    WHERE it.item_id = items.id AND it.deleted_at IS NULL AND t.deleted_at IS NULL
    ORDER BY t.key
  )
) AS tag_names`

const ITEM_SELECT = `SELECT items.*, ${LIVE_TAG_NAMES} FROM items`

const PREFIX_END = String.fromCodePoint(0x10ffff)

class SqliteStore implements Store {
  private readonly statements = new Map<string, StatementSync>()

  constructor(private readonly db: DatabaseSync) {}

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text)
    if (!statement) {
      statement = this.db.prepare(text)
      this.statements.set(text, statement)
    }
    return statement
  }

  liveFileItemByBlob(sha256: string): ItemRecord | null {
    const row = this.sql(
      `${ITEM_SELECT} WHERE blob_sha256 = ? AND link_reason IS NULL AND deleted_at IS NULL`,
    ).get(sha256) as ItemRow | undefined
    return row ? toRecord(row) : null
  }

  item(id: string): ItemRecord | null {
    const row = this.sql(`${ITEM_SELECT} WHERE id = ? AND deleted_at IS NULL`).get(id) as ItemRow | undefined
    return row ? toRecord(row) : null
  }

  commitItem(record: CommitRecord): { id: string; merged: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = record.link ? null : record.blob && this.liveFileItemByBlob(record.blob.sha256)
      const id = existing ? existing.id : record.id
      if (existing) {
        const note = mergeNote(existing.note, record.note)
        this.sql(
          `UPDATE items SET
             note = ?,
             thumb_sha256 = COALESCE(thumb_sha256, ?),
             thumb_width = COALESCE(thumb_width, ?),
             thumb_height = COALESCE(thumb_height, ?),
             width = COALESCE(width, ?),
             height = COALESCE(height, ?),
             updated_at = ?,
             rev = rev + 1
           WHERE id = ?`,
        ).run(
          note,
          record.thumbnail?.sha256 ?? null,
          record.thumbnail?.width ?? null,
          record.thumbnail?.height ?? null,
          record.width,
          record.height,
          record.now,
          id,
        )
      } else {
        this.sql(
          `INSERT INTO items (
             id, kind, blob_sha256, blob_ext, media_type, byte_size, link_reason, link_bytes, playback_time,
             width, height, thumb_sha256, thumb_width, thumb_height, page_url, page_title, media_url, note,
             captured_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          ...([
            id,
            record.kind,
            record.blob?.sha256 ?? null,
            record.blob?.ext ?? null,
            record.blob?.mediaType ?? null,
            record.blob?.bytes ?? null,
            record.link?.reason ?? null,
            record.link?.bytes ?? null,
            record.link?.playbackTime ?? null,
            record.width,
            record.height,
            record.thumbnail?.sha256 ?? null,
            record.thumbnail?.width ?? null,
            record.thumbnail?.height ?? null,
            record.pageUrl,
            record.pageTitle,
            record.mediaUrl,
            record.note,
            record.capturedAt,
            record.now,
            record.now,
          ] satisfies SQLInputValue[]),
        )
      }
      for (const tag of record.tags) this.linkTag(id, tag, record.now)
      this.db.exec('COMMIT')
      return { id, merged: existing !== null }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  updateItem(id: string, patch: ItemPatchRecord): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const live = this.sql('SELECT 1 FROM items WHERE id = ? AND deleted_at IS NULL').get(id) !== undefined
      if (live) {
        this.sql(
          'UPDATE items SET note = COALESCE(?, note), updated_at = ?, rev = rev + 1 WHERE id = ?',
        ).run(patch.note ?? null, patch.now, id)
        if (patch.tags) {
          this.sql(
            `UPDATE item_tags SET deleted_at = ?, updated_at = ?, rev = rev + 1
             WHERE item_id = ? AND deleted_at IS NULL
               AND tag_id NOT IN (
                 SELECT id FROM tags WHERE deleted_at IS NULL AND key IN (SELECT value FROM json_each(?))
               )`,
          ).run(patch.now, patch.now, id, JSON.stringify(patch.tags.map(([, key]) => key)))
          for (const tag of patch.tags) this.linkTag(id, tag, patch.now)
        }
      }
      this.db.exec('COMMIT')
      return live
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  removeItem(id: string, now: number): boolean {
    const result = this.sql(
      'UPDATE items SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND deleted_at IS NULL',
    ).run(now, now, id)
    return Number(result.changes) > 0
  }

  private linkTag(itemId: string, [name, key]: readonly [name: string, key: string], now: number): void {
    this.sql(
      `INSERT INTO tags (id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) WHERE deleted_at IS NULL DO NOTHING`,
    ).run(ulid(now), name, key, now, now)
    this.sql(
      `INSERT INTO item_tags (item_id, tag_id, created_at, updated_at)
       SELECT ?, id, ?, ? FROM tags WHERE key = ? AND deleted_at IS NULL
       ON CONFLICT (item_id, tag_id) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at, rev = rev + 1
         WHERE deleted_at IS NOT NULL`,
    ).run(itemId, now, now, key)
  }

  suggestTags(prefixKey: string, excludeKeys: readonly string[], limit: number): { name: string; uses: number }[] {
    return this.sql(
      `SELECT t.name AS name, count(*) AS uses
       FROM tags t
       JOIN item_tags it ON it.tag_id = t.id AND it.deleted_at IS NULL
       JOIN items i ON i.id = it.item_id AND i.deleted_at IS NULL
       WHERE t.deleted_at IS NULL AND t.key >= ? AND t.key < ?
         AND t.key NOT IN (SELECT value FROM json_each(?))
       GROUP BY t.id
       ORDER BY uses DESC, t.key ASC
       LIMIT ?`,
    )
      .all(prefixKey, prefixKey + PREFIX_END, JSON.stringify(excludeKeys), limit)
      .map((row) => ({ name: String(row.name), uses: Number(row.uses) }))
  }

  tags(): { name: string; uses: number }[] {
    return this.sql(
      `SELECT t.name AS name, count(*) AS uses
       FROM tags t
       JOIN item_tags it ON it.tag_id = t.id AND it.deleted_at IS NULL
       JOIN items i ON i.id = it.item_id AND i.deleted_at IS NULL
       WHERE t.deleted_at IS NULL
       GROUP BY t.id
       ORDER BY uses DESC, t.key ASC`,
    )
      .all()
      .map((row) => ({ name: String(row.name), uses: Number(row.uses) }))
  }

  find(query: FindRecordQuery): ItemRecord[] {
    const where = ['deleted_at IS NULL']
    const params: SQLInputValue[] = []
    if (query.text !== null && [...query.text].length >= TRIGRAM_MIN_CHARS) {
      where.push('seq IN (SELECT rowid FROM items_text WHERE items_text MATCH ?)')
      params.push(`"${query.text.replaceAll('"', '""')}"`)
    } else if (query.text !== null) {
      const pattern = `%${query.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push("(note LIKE ? ESCAPE '\\' OR page_title LIKE ? ESCAPE '\\')")
      params.push(pattern, pattern)
    }
    for (const key of query.tagKeys) {
      where.push(`EXISTS (
        SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id
        WHERE it.item_id = items.id AND it.deleted_at IS NULL AND t.deleted_at IS NULL AND t.key = ?
      )`)
      params.push(key)
    }
    if (query.beforeId !== null) {
      where.push('id < ?')
      params.push(query.beforeId)
    }
    const rows = this.sql(`${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(
      ...params,
      query.limit,
    ) as unknown as ItemRow[]
    return rows.map(toRecord)
  }

  close(): void {
    this.db.close()
  }
}

function mergeNote(existing: string, incoming: string): string {
  if (incoming.trim() === '' || incoming === existing) return existing
  if (existing.trim() === '' || incoming.startsWith(existing)) return incoming
  return `${existing}\n\n${incoming}`
}

function toRecord(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    kind: row.kind,
    blob:
      row.blob_sha256 && row.blob_ext
        ? { sha256: row.blob_sha256, ext: row.blob_ext, mediaType: row.media_type ?? '', bytes: Number(row.byte_size) }
        : null,
    link: row.link_reason
      ? {
          reason: row.link_reason,
          bytes: row.link_bytes === null ? null : Number(row.link_bytes),
          playbackTime: row.playback_time,
        }
      : null,
    thumbnail:
      row.thumb_sha256 && row.thumb_width !== null && row.thumb_height !== null
        ? { sha256: row.thumb_sha256, width: Number(row.thumb_width), height: Number(row.thumb_height) }
        : null,
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    pageUrl: row.page_url,
    pageTitle: row.page_title,
    mediaUrl: row.media_url,
    note: row.note,
    tags: row.tag_names ? (JSON.parse(row.tag_names) as string[]) : [],
    capturedAt: Number(row.captured_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}
