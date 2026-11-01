import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export function projectRelativePath(project: string, cwd: string): string | null {
  if (isAbsolute(cwd)) return null
  try {
    const root = realpathSync(project)
    const target = realpathSync(resolve(root, cwd))
    if (!statSync(target).isDirectory()) return null
    const rel = relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !isAbsolute(rel)) ? rel : null
  } catch {
    return null
  }
}
