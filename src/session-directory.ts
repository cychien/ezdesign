/** The daemon's live sessions: at most one per project, and at most one project
 *  per dev-server origin.
 *
 *  Both invariants live here and nowhere else. The project one is the session
 *  key. The origin one is physical - one port is served by one dev server - and
 *  is derived, never stored twice: `byOrigin` scans the runtimes' own
 *  attachments, so there is no index to fall out of step with them. Every
 *  control route goes through this class, so open, find and restore cannot each
 *  grow their own idea of identity. */

import type { AppAttachment, AttachedApp, PersistedSession } from './store.js'

/** What the directory needs of a session runtime. */
export interface ProjectRuntime {
  readonly project: string
  /** The live attachment, which the proxy routes by. */
  readonly app: AppAttachment
  readonly port: number
  readonly state: 'active' | 'ended'
  /** Ended by the user, which only an explicit `--reopen` undoes. */
  readonly endedByUser: boolean
  start(): Promise<number>
  /** Show `app` in the App tab. `userAttached` - the user ran `ezdesign <url>` -
   *  persists it with its `attachedAt`; a restore or a wake re-attaches what the
   *  record says and writes nothing. */
  attachApp(app: AttachedApp, opts: { userAttached: boolean }): void
  /** Drop the App tab, keep everything else - conversation, queue - and persist
   *  the detachment: another project took the origin. */
  detachApp(): void
  reopen(): void
  setRestoreOnStart(on: boolean): void
  /** Start again the ACP agent the record says this session was driving.
   *  Restore calls it; a `find` that wakes a session for a poller does not -
   *  the poller is the agent. */
  resumeAgent(): void
}

/** The persisted records the directory decides from. Injected so restore and
 *  wake are testable without a data dir. */
export interface SessionRecords {
  /** `listRestorableSessions`: active, `restoreOnStart`, newest `attachedAt` first. */
  restorable(): PersistedSession[]
  /** `persistedSession`: the project's record, if it has one. */
  get(project: string): PersistedSession | null
  /** `migrateLegacySessions`: fold `(origin, project)` directories in. */
  migrate(): void
}

export interface OpenRequest {
  project: string
  /** From `ezdesign <url>`. Absent leaves whatever is attached alone: running
   *  `ezdesign` with no url in a project that has an App tab keeps it. */
  origin?: string
  /** `--reopen`: the user asked for a review they had ended. */
  reopen: boolean
  now: number
}

/** A session the user ended is refused unless `reopen` was asked for, and a
 *  refused open moves nothing - its origin included. */
export type OpenResult<R> = { ok: true; runtime: R } | { ok: false; reason: 'ended-by-user' }

export class SessionDirectory<R extends ProjectRuntime> {
  private readonly live = new Map<string, R>()
  /** Opens still binding their port, so concurrent opens of one project resolve
   *  to one runtime by construction rather than by `listen` happening to resolve
   *  on a later tick. */
  private readonly opening = new Map<string, Promise<R>>()

  constructor(
    private readonly make: (project: string) => R,
    private readonly records: SessionRecords,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** `POST /control/sessions`: the project's session, created when it has none,
   *  with `origin` attached when given. Attaching an origin another project
   *  holds moves it: that session loses only its App tab. */
  async open(req: OpenRequest): Promise<OpenResult<R>> {
    const runtime = await this.ensure(req.project)
    if (runtime.state === 'ended') {
      if (runtime.endedByUser && !req.reopen) return { ok: false, reason: 'ended-by-user' }
      runtime.reopen()
    }
    if (req.origin) {
      const holder = this.byOrigin(req.origin)
      if (holder && holder !== runtime) holder.detachApp()
      runtime.attachApp(
        { kind: 'attached', origin: req.origin, attachedAt: req.now },
        { userAttached: true },
      )
    }
    return { ok: true, runtime }
  }

  /** `GET /control/sessions/find?project=`: the live session, or the persisted
   *  active one woken up - a poll that reconnects after an idle exit still finds
   *  its queued feedback. Null for an unknown or ended project. */
  async find(project: string): Promise<R | null> {
    const live = this.live.get(project)
    if (live) return live
    if (this.opening.has(project)) return this.ensure(project)
    return this.records.get(project)?.state === 'active' ? this.ensure(project) : null
  }

  byOrigin(origin: string): R | undefined {
    for (const runtime of this.live.values()) {
      if (runtime.app.kind === 'attached' && runtime.app.origin === origin) return runtime
    }
    return undefined
  }

  list(): R[] {
    return [...this.live.values()]
  }

  get size(): number {
    return this.live.size
  }

  /** Daemon start: migrate unless a predecessor may still be writing the legacy
   *  directories, then rebuild the sessions that were live, in `restorable()`
   *  order so a contested origin goes to the newest user attach. A record whose
   *  origin a newer one already took comes back with no App tab. */
  async restore(opts: { migrate: boolean }): Promise<void> {
    if (opts.migrate) {
      try {
        this.records.migrate()
      } catch (err) {
        this.log(`legacy session migration failed: ${message(err)}`)
      }
    }
    for (const record of this.records.restorable()) {
      try {
        const runtime = await this.ensure(record.project)
        runtime.resumeAgent()
      } catch (err) {
        this.log(`could not restore session for ${record.project}: ${message(err)}`)
      }
    }
  }

  /** The daemon is exiting for being idle: no shell is open anywhere, so nothing
   *  needs rebuilding. The next daemon opens only what is asked for. */
  retireIdle(): void {
    for (const runtime of this.live.values()) runtime.setRestoreOnStart(false)
  }

  /** The single-flight core of `open`, `find` and `restore`, and the one place a
   *  recorded origin is re-attached. */
  private ensure(project: string): Promise<R> {
    const live = this.live.get(project)
    if (live) return Promise.resolve(live)
    const pending = this.opening.get(project)
    if (pending) return pending
    const started = (async () => {
      const runtime = this.make(project)
      await runtime.start()
      runtime.setRestoreOnStart(true)
      const recorded = this.records.get(project)?.app
      if (recorded?.kind === 'attached') {
        if (this.byOrigin(recorded.origin)) runtime.detachApp()
        else runtime.attachApp(recorded, { userAttached: false })
      }
      this.live.set(project, runtime)
      return runtime
    })()
    this.opening.set(project, started)
    const settle = () => this.opening.delete(project)
    started.then(settle, settle)
    return started
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
