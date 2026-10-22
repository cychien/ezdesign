import { randomBytes } from 'node:crypto'
import { chmodSync, renameSync, writeFileSync } from 'node:fs'

/** The temp file sits beside the target so the rename stays on one filesystem. */
export function writeAtomic(path: string, data: string | Uint8Array, mode?: number): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  writeFileSync(temp, data, mode === undefined ? undefined : { mode })
  if (mode !== undefined) chmodSync(temp, mode)
  renameSync(temp, path)
}
