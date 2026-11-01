import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Initiator } from '../dev-server/index.js'
import type { DevServerSummaryWire } from '../dev-server/wire.js'
import type { OpenRequest, OpenResult, ProjectRuntime } from '../session-directory.js'
import type { ProjectBook } from './book.js'
import type { ProjectListWire, ProjectOpenedWire, ProjectWire } from './wire.js'

export interface HubRuntime extends ProjectRuntime {
  readonly devServer: {
    summary(): DevServerSummaryWire
    ensure(by: Initiator): void
    stop(): Promise<void>
    readonly external: boolean
  }
  shellUrl(path?: string): string
}

export interface HubSessions<R> {
  list(): R[]
  open(req: OpenRequest): Promise<OpenResult<R>>
}

export interface ProjectHubDeps<R extends HubRuntime> {
  sessions: HubSessions<R>
  book: ProjectBook
  version: string
  projectRoot(path: string): string
  restored(): Promise<void>
}

export type OpenRefusal = { ok: false; status: 404; error: string }

export class ProjectHub<R extends HubRuntime> {
  private readonly listeners = new Set<() => void>()
  private touched = false

  constructor(private readonly deps: ProjectHubDeps<R>) {}

  list(): ProjectListWire {
    const runtimes = new Map(this.deps.sessions.list().map((r) => [r.project, r]))
    const projects: ProjectWire[] = this.deps.book.list().map((row) => {
      const runtime = runtimes.get(row.project)
      return { ...row, session: runtime ? { devServer: runtime.devServer.summary() } : null }
    })
    return { version: this.deps.version, projects }
  }

  add(path: string): ProjectWire | { error: string } {
    if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      return { error: 'not a folder on this computer' }
    }
    const project = this.deps.projectRoot(path)
    this.deps.book.add(project, Date.now())
    this.changed()
    return this.list().projects.find((p) => p.project === project)!
  }

  hide(project: string): void {
    this.deps.book.hide(project, Date.now())
    this.changed()
  }

  async open(project: string, by: Initiator): Promise<ProjectOpenedWire | OpenRefusal> {
    if (!this.deps.book.isListed(project)) return { ok: false, status: 404, error: 'not a project on the list' }
    await this.deps.restored()
    const opened = await this.deps.sessions.open({ project, reopen: true, now: Date.now() })
    if (!opened.ok) return { ok: false, status: 404, error: 'the review could not be opened' }
    const { runtime } = opened
    runtime.devServer.ensure(by)
    this.changed()
    return { project, shellUrl: runtime.shellUrl() }
  }

  async stop(project: string): Promise<void> {
    const runtime = this.deps.sessions.list().find((r) => r.project === project)
    if (runtime && !runtime.devServer.external) await runtime.devServer.stop()
  }

  changed(): void {
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.touched = true
    return () => this.listeners.delete(listener)
  }

  takeBusy(): boolean {
    const busy = this.touched || this.listeners.size > 0
    this.touched = false
    return busy
  }
}
