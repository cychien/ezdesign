import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { PROJECTS_FILE } from '../constants.js'
import { writeAtomic } from '../fs-atomic.js'

export interface BookEntry {
  usedAt?: number
  addedAt?: number
  hiddenAt?: number
}

interface BookFile {
  version: 1
  projects: Record<string, BookEntry>
}

export interface ListedProject {
  project: string
  name: string
  usedAt: number | null
  exists: boolean
}

export class ProjectBook {
  private readonly entries: Map<string, BookEntry>
  private readonly withSession: Map<string, { createdAt: number }>

  constructor(
    sessions: Iterable<{ project: string; createdAt: number }>,
    private readonly file: string = PROJECTS_FILE,
  ) {
    this.entries = readBook(file)
    this.withSession = new Map([...sessions].map((s) => [s.project, { createdAt: s.createdAt }]))
  }

  markUsed(project: string, now: number): void {
    if (!this.withSession.has(project)) this.withSession.set(project, { createdAt: now })
    this.update(project, { usedAt: now })
  }

  add(project: string, now: number): void {
    this.update(project, { addedAt: now })
  }

  hide(project: string, now: number): void {
    if (this.isListed(project)) this.update(project, { hiddenAt: now })
  }

  isListed(project: string): boolean {
    return this.entries.has(project) || this.withSession.has(project)
  }

  list(): ListedProject[] {
    return mergeProjects(this.entries, this.withSession, (project) => existsSync(project))
  }

  private update(project: string, change: BookEntry): void {
    this.entries.set(project, { ...this.entries.get(project), ...change })
    const file: BookFile = { version: 1, projects: Object.fromEntries(this.entries) }
    writeAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`)
  }
}

const isHidden = (entry: BookEntry) =>
  entry.hiddenAt !== undefined && entry.hiddenAt >= Math.max(entry.usedAt ?? 0, entry.addedAt ?? 0)

export function mergeProjects(
  entries: ReadonlyMap<string, BookEntry>,
  sessions: ReadonlyMap<string, { createdAt: number }>,
  exists: (project: string) => boolean,
): ListedProject[] {
  const rows: (ListedProject & { order: number })[] = []
  for (const project of new Set([...entries.keys(), ...sessions.keys()])) {
    const entry = entries.get(project) ?? {}
    if (isHidden(entry)) continue
    const usedAt = entry.usedAt ?? entry.addedAt ?? sessions.get(project)?.createdAt ?? null
    rows.push({ project, name: basename(project), usedAt, exists: exists(project), order: usedAt ?? 0 })
  }
  return rows
    .sort((a, b) => b.order - a.order || a.project.localeCompare(b.project))
    .map(({ order: _, ...row }) => row)
}

function readBook(file: string): Map<string, BookEntry> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BookFile>
    return new Map(Object.entries(parsed.projects ?? {}))
  } catch {
    return new Map()
  }
}
