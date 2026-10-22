import { randomBytes } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'

/** The temp file sits beside the target so the rename stays on one filesystem. */
export function writeAtomic(path: string, data: string | Uint8Array): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  writeFileSync(temp, data)
  renameSync(temp, path)
}
