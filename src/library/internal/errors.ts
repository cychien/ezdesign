export type LibraryErrorCode =
  /** This node has no `node:sqlite` (older than 22.13). */
  | 'node-too-old'
  /** The db was written by an ezdesign with an incompatible schema epoch. */
  | 'schema-newer'
  /** Bytes that are not what they claim: a sha256 mismatch, a thumbnail that is not a small WebP. */
  | 'integrity'
  /** Bytes the library does not keep as this kind, such as an HTML page staged as an image. */
  | 'unsupported-media'
  /** The stage was discarded or committed. */
  | 'stage-closed'
  /** The disk or the db failed; `retryable` when waiting may help (disk full, db busy). */
  | 'io'

export class LibraryError extends Error {
  constructor(
    readonly code: LibraryErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'LibraryError'
  }
}

const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const SQLITE_FULL = 13

/** The primary SQLite result code of a `node:sqlite` error, or null. */
function sqliteCode(error: unknown): number | null {
  const { errcode } = (error ?? {}) as { errcode?: unknown }
  return typeof errcode === 'number' ? errcode & 0xff : null
}

export function isBusy(error: unknown): boolean {
  const code = sqliteCode(error)
  return code === SQLITE_BUSY || code === SQLITE_LOCKED
}

export function asLibraryError(error: unknown): LibraryError {
  if (error instanceof LibraryError) return error
  const full = sqliteCode(error) === SQLITE_FULL || (error as { code?: unknown } | null)?.code === 'ENOSPC'
  return new LibraryError('io', error instanceof Error ? error.message : String(error), isBusy(error) || full)
}
