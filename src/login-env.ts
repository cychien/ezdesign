import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export function findExecutable(binary: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binary)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}
