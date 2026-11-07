/** Whether the extension is installed right now. Each browser profile keeps a
 *  record of its extensions, the one `chrome://extensions` shows, but writes it
 *  down only on its commit timer, some ten seconds late. The extension greets
 *  the native host the moment it is loaded, so a greeting newer than every
 *  record stands in until the records catch up. A greeting alone is never
 *  enough: it outlives the extension being removed. */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionSeen } from '../capture-seen.js'
import { EXTENSION_ID } from '../capture-wire.js'
import type { ExtensionPresenceWire } from '../setup-wire.js'
import { CHROMIUM_BROWSERS } from './browsers.js'

/** Unpacked extensions are kept in the protected file; both are read in case a build keeps them in the other. */
const PREFERENCE_FILES = ['Secure Preferences', 'Preferences'] as const
const PROFILE_DIR = /^(Default|Profile \d+)$/

interface ExtensionSettings {
  path?: unknown
  disable_reasons?: unknown
  state?: unknown
}

/** A removed extension can leave `{}` under its id until the browser restarts. */
function installedAndEnabled(settings: ExtensionSettings): boolean {
  if (typeof settings.path !== 'string') return false
  const reasons = settings.disable_reasons
  if (Array.isArray(reasons) && reasons.length > 0) return false
  if (typeof reasons === 'number' && reasons !== 0) return false
  // Chrome before disable reasons wrote 0 for a disabled extension.
  return settings.state !== 0
}

async function profilesOf(userDataDir: string): Promise<string[]> {
  try {
    return (await readdir(userDataDir)).filter((name) => PROFILE_DIR.test(name)).map((name) => join(userDataDir, name))
  } catch {
    return []
  }
}

export interface RecordFile {
  path: string
  browser: string
}

/** Every profile record there is to read, for a watcher to stat. */
export async function extensionRecordFiles(options: { home: string; platform: NodeJS.Platform }): Promise<RecordFile[]> {
  const { platform } = options
  if (platform !== 'darwin' && platform !== 'linux') return []
  const perBrowser = await Promise.all(
    CHROMIUM_BROWSERS.map(async (browser) => {
      const dir = browser.userDataDir[platform]
      if (!dir) return []
      const profiles = await profilesOf(join(options.home, dir))
      return profiles.flatMap((profile) => PREFERENCE_FILES.map((file) => ({ path: join(profile, file), browser: browser.name })))
    }),
  )
  return perBrowser.flat()
}

async function readRecord(file: RecordFile): Promise<{ mtime: number; settings: ExtensionSettings | null } | null> {
  try {
    const [info, text] = await Promise.all([stat(file.path), readFile(file.path, 'utf8')])
    const prefs = JSON.parse(text) as { extensions?: { settings?: Record<string, ExtensionSettings> } }
    return { mtime: info.mtimeMs, settings: prefs.extensions?.settings?.[EXTENSION_ID] ?? null }
  } catch {
    // Missing, or caught mid-write: the next look decides.
    return null
  }
}

export async function readExtensionPresence(options: {
  files: readonly RecordFile[]
  greeted: ExtensionSeen | null
}): Promise<ExtensionPresenceWire> {
  const records = await Promise.all(options.files.map(async (file) => ({ file, record: await readRecord(file) })))
  const installedIn = [
    ...new Set(
      records.filter(({ record }) => record?.settings && installedAndEnabled(record.settings)).map(({ file }) => file.browser),
    ),
  ]
  // The plain file is rewritten every few seconds for unrelated reasons; the
  // protected one, which holds the extension, is the record to beat.
  const secure = records.filter(({ file, record }) => record && file.path.endsWith(PREFERENCE_FILES[0]))
  const newestRecord = Math.max(0, ...(secure.length ? secure : records).map(({ record }) => record?.mtime ?? 0))
  const greetedSince = !!options.greeted && options.greeted.at > newestRecord
  return { installed: installedIn.length > 0 || greetedSince, installedIn }
}
