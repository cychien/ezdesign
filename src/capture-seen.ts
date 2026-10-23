/** The last extension the native host greeted, which is how the shell knows
 *  saving works without asking the browser. Beside the host, so removing the
 *  host forgets it. */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nativeHostDir } from './constants.js'
import { writeAtomic } from './fs-atomic.js'

export interface ExtensionSeen {
  version: string
  at: number
}

const seenFile = (dataDir: string) => join(nativeHostDir(dataDir), 'extension-seen.json')

export function recordExtensionSeen(dataDir: string, version: string): void {
  mkdirSync(dirname(seenFile(dataDir)), { recursive: true })
  writeAtomic(seenFile(dataDir), `${JSON.stringify({ version, at: Date.now() } satisfies ExtensionSeen)}\n`)
}

export function readExtensionSeen(dataDir: string): ExtensionSeen | null {
  try {
    const { version, at } = JSON.parse(readFileSync(seenFile(dataDir), 'utf8')) as Partial<ExtensionSeen>
    return typeof version === 'string' && typeof at === 'number' ? { version, at } : null
  } catch {
    return null
  }
}
