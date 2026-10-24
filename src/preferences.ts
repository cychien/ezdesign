import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './constants.js'
import type { DesignEffort } from './truth.js'

/** Per user, keyed by project path, so a dev server that moved ports keeps the choice. */
export const PREFERENCES_FILE = join(DATA_DIR, 'preferences.json')

interface Preferences {
  designHarness?: Record<string, boolean>
  designEffort?: Record<string, DesignEffort>
  announcementsSeen?: string[]
}

function read(file: string): Preferences {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Preferences
  } catch {
    return {}
  }
}

export function rememberedDesignHarness(
  project: string,
  file = PREFERENCES_FILE,
): boolean | undefined {
  return read(file).designHarness?.[project]
}

export function rememberDesignHarness(project: string, on: boolean, file = PREFERENCES_FILE): void {
  const prefs = read(file)
  write(file, { ...prefs, designHarness: { ...prefs.designHarness, [project]: on } })
}

export function rememberedDesignEffort(
  project: string,
  file = PREFERENCES_FILE,
): DesignEffort | undefined {
  return read(file).designEffort?.[project]
}

export function rememberDesignEffort(
  project: string,
  effort: DesignEffort,
  file = PREFERENCES_FILE,
): void {
  const prefs = read(file)
  write(file, { ...prefs, designEffort: { ...prefs.designEffort, [project]: effort } })
}

export function seenAnnouncements(file = PREFERENCES_FILE): string[] {
  return read(file).announcementsSeen ?? []
}

export function rememberAnnouncementSeen(id: string, file = PREFERENCES_FILE): string[] {
  const prefs = read(file)
  const seen = prefs.announcementsSeen ?? []
  if (seen.includes(id)) return seen
  const next = [...seen, id]
  write(file, { ...prefs, announcementsSeen: next })
  return next
}

function write(file: string, prefs: Preferences): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(prefs, null, 2))
}
