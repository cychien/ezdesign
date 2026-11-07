import { randomBytes } from 'node:crypto'
import { chmodSync, constants, copyFileSync, renameSync, writeFileSync } from 'node:fs'

/** The temp file sits beside the target so the rename stays on one filesystem. */
export function writeAtomic(path: string, data: string | Uint8Array, mode?: number): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  writeFileSync(temp, data, mode === undefined ? undefined : { mode })
  if (mode !== undefined) chmodSync(temp, mode)
  renameSync(temp, path)
}

/** A copy that shares the source's blocks where the filesystem can (an APFS
 *  clone costs no bytes and no time) and is a plain copy where it cannot. */
export function cloneAtomic(from: string, to: string): void {
  const temp = `${to}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  copyFileSync(from, temp, constants.COPYFILE_FICLONE)
  renameSync(temp, to)
}
