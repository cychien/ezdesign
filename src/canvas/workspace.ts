/** A project's canvases: the only code that reads or writes
 *  `<project>/.ezdesign/canvases/`, and the only owner of the active tab.
 *
 *  On disk, per canvas:
 *
 *      <canvasId>/canvas.json         manifest: name, createdAt, archivedAt, and
 *                                     frames {id, title, file, hash, createdAt,
 *                                     deletedAt?} bottom to top (z-order)
 *      <canvasId>/layout.json         frame rects by id
 *      <canvasId>/frames/<frameId>.html   one complete document per frame
 *
 *  There is no workspace-level index: tab order is `createdAt`, the open set is
 *  "not archived". Camera and active tab are the viewer's and live in the
 *  session's `view.json` through `ViewStore`.
 *
 *  `canvas.json` and `layout.json` are written by this module alone, atomically
 *  (temp file, rename), and never read back after an outside edit: the next
 *  write from here replaces whatever someone put there. Frame HTML can also be
 *  written from outside (the agent's own file tools, any editor), so a frame's
 *  hash is always re-read from its file.
 *
 *  Crash order: bytes before manifest on every create, manifest before unlink
 *  on every drop, so a crash leaves an unnamed file, never a named one that is
 *  missing. `start()` sweeps unnamed files older than an hour.
 *
 *  Ownership is in the types: the class below is not exported, and callers get
 *  the narrow ports `openCanvasWorkspace` hands out. */

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { FrameRef } from '../protocol.js'
import { type FrameOverlayConfig, frameUrl, renderFrameDocument } from './frame-document.js'
import {
  CANVASES_DIR,
  type Canvas,
  type CanvasFrame,
  type CanvasId,
  type CanvasInventory,
  type CanvasSummary,
  type FrameId,
  MAX_CANVAS_NAME,
  type Outcome,
  type Rect,
  type TabId,
  type ViewStore,
  asCanvasId,
  asFrameId,
} from './types.js'
import type { CanvasSnapshotWire, CanvasWire, ViewWire } from './wire.js'

/** The tab strip's `+` and the empty start: one name, numbered past those taken. */
export const UNTITLED = '未命名 canvas'

/** The user's side, from the shell's routes: the canvas lifecycle and the view.
 *  No route can write a document. */
export interface UserCanvasPort {
  /** An unnamed canvas is called `未命名 canvas`, numbered past existing ones.
   *  Becomes the active tab. */
  create(name?: string): Outcome<CanvasWire>
  rename(canvasId: string, name: string): Outcome<CanvasWire>
  /** Closing a tab. An empty canvas with its default name is deleted instead -
   *  nothing in it to keep, and it stops empty-start canvases piling up.
   *  Idempotent. The active tab moves to the nearest open tab; with none left,
   *  a fresh empty canvas opens. */
  archive(canvasId: string): Outcome<'archived' | 'deleted'>
  /** Becomes the active tab. */
  reopen(canvasId: string): Outcome<CanvasWire>
  /** Permanent, archived canvases only (`CANVAS_OPEN` otherwise): the whole
   *  directory, and its saved camera. The shell confirms first; this does not. */
  delete(canvasId: string): Outcome<void>
  setView(view: ViewWire): void
}

/** Reads every side may make. Nothing here writes, except a frame whose file
 *  changed behind the manifest's back getting its hash brought up to date. */
export interface CanvasReader {
  snapshot(agentHasTools: boolean): CanvasSnapshotWire
  /** Null for an unknown canvas. */
  wire(canvasId: CanvasId): CanvasWire | null
  /** Open canvases in tab order: the first SSE flush of a shell client. */
  openWires(): CanvasWire[]
  inventory(): CanvasInventory
  /** An anchor's `frame`, checked against what exists, before an annotation
   *  carrying it is stored. */
  hasFrame(ref: FrameRef): boolean
  /** Titles for an agent-facing label. */
  names(ref: FrameRef): { canvas: string; frame: string } | null
  /** The document for one frame as the frame host serves it: stamped with
   *  `data-ez-source`, relay overlay injected, cached by hash. Null when the
   *  canvas, the frame or its file is gone. */
  frameDocument(canvasId: CanvasId, frameId: FrameId): { html: string; hash: string } | null
}

export type CanvasChange =
  /** Anything about one canvas: frames, a document's hash, name, archive state. */
  | { kind: 'updated'; canvasId: CanvasId }
  /** Gone for good. */
  | { kind: 'removed'; canvasId: CanvasId }
  /** The active tab moved. */
  | { kind: 'view' }

export interface CanvasWorkspaceOptions {
  project: string
  view: ViewStore
  /** `http://localhost:<port>`. Asked per projection, never held: a restored
   *  session can come back on another port. */
  frameOrigin: () => string
  /** The overlay config every served frame gets, minus its own place. */
  overlay: () => Omit<FrameOverlayConfig, 'place'>
  /** Whether an App tab exists: the active tab never names a tab that does not. */
  hasApp: () => boolean
  onChange: (change: CanvasChange) => void
  log?: (message: string) => void
  now?: () => number
}

export interface CanvasWorkspace {
  readonly user: UserCanvasPort
  readonly read: CanvasReader
  /** After the session's port is bound: read every manifest and run the startup
   *  sweep. Never creates a canvas - a restore must not write into a project
   *  nobody is looking at. Idempotent. */
  start(): void
  /** A review shell connected: make sure it has a tab to show, opening an empty
   *  canvas when there is neither an app nor an open canvas. */
  shellConnected(): void
  /** The App tab came or went. `show`: the user ran `ezdesign <url>` to look at
   *  it, so the App tab becomes active. `create`: a shell is open, so a strip
   *  left with nothing gets an empty canvas. The workspace is the one writer of
   *  the active tab. */
  appChanged(opts: { show: boolean; create: boolean }): void
  close(): void
}

export function openCanvasWorkspace(options: CanvasWorkspaceOptions): CanvasWorkspace {
  const workspace = new Workspace(options)
  return {
    user: workspace.userPort(),
    read: workspace.reader(),
    start: () => workspace.start(),
    shellConnected: () => workspace.ensureTab(true),
    appChanged: (opts) => workspace.appChanged(opts),
    close: () => workspace.close(),
  }
}

// ------------------------------------------------------------------ storage

/** `canvas.json`. `schema` is what a future reader branches on. */
interface ManifestFile {
  schema: 1
  id: CanvasId
  name: string
  createdAt: number
  archivedAt?: number
  frames: ManifestFrame[]
}

interface ManifestFrame {
  id: FrameId
  title: string
  /** Canvas-relative: `frames/<frameId>.html`. */
  file: string
  hash: string
  createdAt: number
  /** Soft delete. Purged from the manifest after `DELETED_KEEP_MS`, after which
   *  the sweep collects the file. */
  deletedAt?: number
}

/** `layout.json`. */
interface LayoutFile {
  schema: 1
  rects: Partial<Record<FrameId, Rect>>
}

interface Held {
  manifest: ManifestFile
  layout: LayoutFile
}

const UNNAMED_FILE_GRACE_MS = 60 * 60_000
const DELETED_KEEP_MS = 7 * 24 * 60 * 60_000
/** Where a frame with no rect on record is drawn: never lost off-board. */
const NO_RECT: Rect = { x: 0, y: 0, width: 1280, height: 800 }

const sha1 = (bytes: string | Buffer) => createHash('sha1').update(bytes).digest('hex').slice(0, 12)

function writeAtomic(path: string, data: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  writeFileSync(temp, data)
  renameSync(temp, path)
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** One line of plain text a person can read on a tab: control characters and
 *  runs of whitespace go, and the result has to be non-empty and short. */
export function cleanName(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return name && [...name].length <= max ? name : null
}

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })

class Workspace {
  private readonly canvases = new Map<CanvasId, Held>()
  /** `frameDocument` cache: `${canvasId}/${frameId}` -> the stamped document of one hash. */
  private readonly served = new Map<string, { hash: string; html: string }>()
  private readonly root: string

  constructor(private readonly opts: CanvasWorkspaceOptions) {
    this.root = join(opts.project, CANVASES_DIR)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private log(message: string): void {
    this.opts.log?.(message)
  }

  userPort(): UserCanvasPort {
    return {
      create: (name) => this.create(name),
      rename: (canvasId, name) => this.rename(canvasId, name),
      archive: (canvasId) => this.archive(canvasId),
      reopen: (canvasId) => this.reopen(canvasId),
      delete: (canvasId) => this.delete(canvasId),
      setView: (view) => this.setView(view),
    }
  }

  reader(): CanvasReader {
    return {
      snapshot: (agentHasTools) => ({
        canvases: this.summaries(),
        activeTab: this.activeTab(),
        agentHasTools,
      }),
      wire: (canvasId) => this.wire(canvasId),
      openWires: () =>
        this.ordered()
          .filter((h) => h.manifest.archivedAt === undefined)
          .map((h) => this.wire(h.manifest.id)!),
      inventory: () => ({ activeTab: this.activeTab(), canvases: this.summaries() }),
      hasFrame: (ref) => this.liveFrame(ref.canvasId, ref.frameId) !== null,
      names: (ref) => {
        const held = this.held(ref.canvasId)
        const frame = this.liveFrame(ref.canvasId, ref.frameId)
        return held && frame ? { canvas: held.manifest.name, frame: frame.title } : null
      },
      frameDocument: (canvasId, frameId) => this.frameDocument(canvasId, frameId),
    }
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    this.canvases.clear()
    let dirs: string[]
    try {
      dirs = readdirSync(this.root)
    } catch {
      return
    }
    for (const name of dirs) {
      const id = asCanvasId(name)
      if (!id) continue
      const manifest = readJson<ManifestFile>(join(this.root, id, 'canvas.json'))
      if (!manifest || manifest.schema !== 1 || manifest.id !== id || !Array.isArray(manifest.frames)) {
        this.log(`canvas ${id}: canvas.json is unreadable or from a newer version; left alone`)
        continue
      }
      const layout = readJson<LayoutFile>(join(this.root, id, 'layout.json'))
      const held: Held = {
        manifest,
        layout: layout?.schema === 1 && layout.rects ? layout : { schema: 1, rects: {} },
      }
      this.canvases.set(id, held)
      this.rehash(held)
      this.sweep(held)
    }
  }

  close(): void {
    this.served.clear()
  }

  appChanged(opts: { show: boolean; create: boolean }): void {
    if (opts.show && this.opts.hasApp() && this.opts.view.view.activeTab !== 'app') {
      this.opts.view.setActiveTab('app')
      this.opts.onChange({ kind: 'view' })
    }
    this.ensureTab(opts.create)
  }

  /** The tab strip is never empty and never names a tab that is gone. */
  ensureTab(create: boolean): void {
    const active = this.opts.view.view.activeTab
    if (active !== undefined && this.tabExists(active)) return
    const next: TabId | undefined = this.opts.hasApp()
      ? 'app'
      : (this.open()[0]?.manifest.id ?? (create ? this.createCanvas().manifest.id : undefined))
    if (next === undefined || next === active) return
    this.opts.view.setActiveTab(next)
    this.opts.onChange({ kind: 'view' })
  }

  // ------------------------------------------------------------------ queries

  private ordered(): Held[] {
    return [...this.canvases.values()].sort(
      (a, b) => a.manifest.createdAt - b.manifest.createdAt || a.manifest.id.localeCompare(b.manifest.id),
    )
  }

  private open(): Held[] {
    return this.ordered().filter((h) => h.manifest.archivedAt === undefined)
  }

  private tabExists(tab: TabId): boolean {
    if (tab === 'app') return this.opts.hasApp()
    const held = this.canvases.get(tab)
    return !!held && held.manifest.archivedAt === undefined
  }

  private activeTab(): TabId | null {
    const active = this.opts.view.view.activeTab
    if (active !== undefined && this.tabExists(active)) return active
    if (this.opts.hasApp()) return 'app'
    return this.open()[0]?.manifest.id ?? null
  }

  private summaries(): CanvasSummary[] {
    return this.ordered().map((h) => ({
      id: h.manifest.id,
      name: h.manifest.name,
      archived: h.manifest.archivedAt !== undefined,
      frames: h.manifest.frames.filter((f) => f.deletedAt === undefined).length,
      createdAt: h.manifest.createdAt,
    }))
  }

  private held(canvasId: string): Held | null {
    const id = asCanvasId(canvasId)
    return (id && this.canvases.get(id)) || null
  }

  private liveFrame(canvasId: string, frameId: string): ManifestFrame | null {
    const held = this.held(canvasId)
    const id = asFrameId(frameId)
    if (!held || !id) return null
    return held.manifest.frames.find((f) => f.id === id && f.deletedAt === undefined) ?? null
  }

  private project(held: Held): Canvas {
    const { manifest, layout } = held
    return {
      id: manifest.id,
      name: manifest.name,
      createdAt: manifest.createdAt,
      ...(manifest.archivedAt !== undefined ? { archivedAt: manifest.archivedAt } : {}),
      frames: manifest.frames
        .filter((f) => f.deletedAt === undefined)
        .map(
          (f): CanvasFrame => ({
            id: f.id,
            title: f.title,
            file: `${CANVASES_DIR}/${manifest.id}/${f.file}`,
            hash: f.hash,
            rect: layout.rects[f.id] ?? NO_RECT,
            createdAt: f.createdAt,
          }),
        ),
    }
  }

  private wire(canvasId: CanvasId): CanvasWire | null {
    const held = this.canvases.get(canvasId)
    if (!held) return null
    const canvas = this.project(held)
    const camera = this.opts.view.view.cameras?.[canvasId]
    const origin = this.opts.frameOrigin()
    return {
      id: canvas.id,
      name: canvas.name,
      archived: canvas.archivedAt !== undefined,
      createdAt: canvas.createdAt,
      ...(camera ? { camera } : {}),
      frames: canvas.frames.map((f) => ({
        id: f.id,
        title: f.title,
        rect: f.rect,
        file: f.file,
        hash: f.hash,
        src: frameUrl(origin, canvas.id, f.id, f.hash),
      })),
    }
  }

  private notFound(canvasId: string): Outcome<never> {
    return {
      ok: false,
      problem: {
        code: 'CANVAS_NOT_FOUND',
        canvasId,
        known: this.ordered().map((h) => ({ id: h.manifest.id, name: h.manifest.name })),
      },
    }
  }

  /** An open canvas, or why it may not be changed. */
  private writable(canvasId: string): Outcome<Held> {
    const held = this.held(canvasId)
    if (!held) return this.notFound(canvasId)
    if (held.manifest.archivedAt !== undefined) {
      return { ok: false, problem: { code: 'CANVAS_ARCHIVED', canvasId: held.manifest.id, name: held.manifest.name } }
    }
    return ok(held)
  }

  // --------------------------------------------------------------- the files

  private dir(id: CanvasId): string {
    return join(this.root, id)
  }

  private writeManifest(held: Held): void {
    writeAtomic(join(this.dir(held.manifest.id), 'canvas.json'), JSON.stringify(held.manifest, null, 2))
  }

  private writeLayout(held: Held): void {
    writeAtomic(join(this.dir(held.manifest.id), 'layout.json'), JSON.stringify(held.layout, null, 2))
  }

  /** A file edited while the daemon was not watching: its hash moves. */
  private rehash(held: Held): void {
    let moved = false
    for (const frame of held.manifest.frames) {
      if (frame.deletedAt !== undefined) continue
      try {
        const hash = sha1(readFileSync(join(this.dir(held.manifest.id), frame.file)))
        if (hash !== frame.hash) {
          frame.hash = hash
          moved = true
        }
      } catch {
        /* missing: served as gone, kept in the manifest for the user to remove */
      }
    }
    if (moved) this.writeManifest(held)
  }

  private sweep(held: Held): void {
    const cutoff = this.now() - DELETED_KEEP_MS
    const kept = held.manifest.frames.filter((f) => f.deletedAt === undefined || f.deletedAt > cutoff)
    if (kept.length !== held.manifest.frames.length) {
      held.manifest.frames = kept
      this.writeManifest(held)
    }
    const named = new Set(held.manifest.frames.map((f) => f.file))
    const framesDir = join(this.dir(held.manifest.id), 'frames')
    let files: string[]
    try {
      files = readdirSync(framesDir)
    } catch {
      return
    }
    const old = this.now() - UNNAMED_FILE_GRACE_MS
    for (const name of files) {
      if (named.has(`frames/${name}`)) continue
      const path = join(framesDir, name)
      try {
        if (statSync(path).mtimeMs < old) unlinkSync(path)
      } catch {
        /* raced with a manual delete */
      }
    }
  }

  private frameDocument(canvasId: CanvasId, frameId: FrameId): { html: string; hash: string } | null {
    const held = this.canvases.get(canvasId)
    const frame = this.liveFrame(canvasId, frameId)
    if (!held || !frame) return null
    let bytes: Buffer
    try {
      bytes = readFileSync(join(this.dir(canvasId), frame.file))
    } catch {
      return null
    }
    const hash = sha1(bytes)
    const key = `${canvasId}/${frameId}`
    const cached = this.served.get(key)
    if (cached?.hash === hash) return cached
    if (hash !== frame.hash) {
      frame.hash = hash
      this.writeManifest(held)
      this.opts.onChange({ kind: 'updated', canvasId })
    }
    const html = renderFrameDocument({
      html: bytes.toString('utf8'),
      file: `${CANVASES_DIR}/${canvasId}/${frame.file}`,
      overlay: { ...this.opts.overlay(), place: { canvasId, frameId } },
    })
    const served = { hash, html }
    this.served.set(key, served)
    return served
  }

  // -------------------------------------------------------------- user edits

  private untitledName(): string {
    const taken = new Set(this.ordered().map((h) => h.manifest.name))
    if (!taken.has(UNTITLED)) return UNTITLED
    for (let n = 2; ; n++) if (!taken.has(`${UNTITLED} ${n}`)) return `${UNTITLED} ${n}`
  }

  private createCanvas(name?: string): Held {
    let id: CanvasId
    do id = randomBytes(6).toString('hex') as CanvasId
    while (this.canvases.has(id) || existsSync(this.dir(id)))
    mkdirSync(join(this.dir(id), 'frames'), { recursive: true })
    const held: Held = {
      manifest: { schema: 1, id, name: name ?? this.untitledName(), createdAt: this.now(), frames: [] },
      layout: { schema: 1, rects: {} },
    }
    this.writeLayout(held)
    this.writeManifest(held)
    this.canvases.set(id, held)
    this.opts.view.setActiveTab(id)
    this.opts.onChange({ kind: 'updated', canvasId: id })
    this.opts.onChange({ kind: 'view' })
    return held
  }

  private create(name?: string): Outcome<CanvasWire> {
    const clean = name === undefined ? undefined : cleanName(name, MAX_CANVAS_NAME)
    if (clean === null) return { ok: false, problem: { code: 'BAD_NAME', max: MAX_CANVAS_NAME } }
    return ok(this.wire(this.createCanvas(clean).manifest.id)!)
  }

  private rename(canvasId: string, name: string): Outcome<CanvasWire> {
    const writable = this.writable(canvasId)
    if (!writable.ok) return writable
    const clean = cleanName(name, MAX_CANVAS_NAME)
    if (clean === null) return { ok: false, problem: { code: 'BAD_NAME', max: MAX_CANVAS_NAME } }
    const held = writable.value
    if (held.manifest.name !== clean) {
      held.manifest.name = clean
      this.writeManifest(held)
      this.opts.onChange({ kind: 'updated', canvasId: held.manifest.id })
    }
    return ok(this.wire(held.manifest.id)!)
  }

  /** Where the active tab goes when `leaving` closes: the next open tab, else
   *  the one before, else the App. */
  private neighbour(leaving: CanvasId): TabId | undefined {
    const open = this.open().map((h) => h.manifest.id)
    const at = open.indexOf(leaving)
    const rest = open.filter((id) => id !== leaving)
    return rest[at] ?? rest[at - 1] ?? (this.opts.hasApp() ? 'app' : undefined)
  }

  private archive(canvasId: string): Outcome<'archived' | 'deleted'> {
    const held = this.held(canvasId)
    if (!held) return this.notFound(canvasId)
    const id = held.manifest.id
    if (held.manifest.archivedAt !== undefined) return ok('archived')
    const wasActive = this.opts.view.view.activeTab === id
    const next = wasActive ? this.neighbour(id) : undefined
    const empty = held.manifest.frames.every((f) => f.deletedAt !== undefined)
    const untitled = held.manifest.name === UNTITLED || held.manifest.name.startsWith(`${UNTITLED} `)
    let result: 'archived' | 'deleted'
    if (empty && untitled) {
      this.remove(held)
      result = 'deleted'
    } else {
      held.manifest.archivedAt = this.now()
      this.writeManifest(held)
      this.opts.onChange({ kind: 'updated', canvasId: id })
      result = 'archived'
    }
    if (wasActive && next !== undefined) {
      this.opts.view.setActiveTab(next)
      this.opts.onChange({ kind: 'view' })
    }
    this.ensureTab(true)
    return ok(result)
  }

  private reopen(canvasId: string): Outcome<CanvasWire> {
    const held = this.held(canvasId)
    if (!held) return this.notFound(canvasId)
    const id = held.manifest.id
    if (held.manifest.archivedAt !== undefined) {
      delete held.manifest.archivedAt
      this.writeManifest(held)
      this.opts.onChange({ kind: 'updated', canvasId: id })
    }
    if (this.opts.view.view.activeTab !== id) {
      this.opts.view.setActiveTab(id)
      this.opts.onChange({ kind: 'view' })
    }
    return ok(this.wire(id)!)
  }

  private remove(held: Held): void {
    const id = held.manifest.id
    rmSync(this.dir(id), { recursive: true, force: true })
    this.canvases.delete(id)
    for (const key of this.served.keys()) if (key.startsWith(`${id}/`)) this.served.delete(key)
    this.opts.view.forgetCamera(id)
    this.opts.onChange({ kind: 'removed', canvasId: id })
  }

  private delete(canvasId: string): Outcome<void> {
    const held = this.held(canvasId)
    if (!held) return this.notFound(canvasId)
    if (held.manifest.archivedAt === undefined) {
      return { ok: false, problem: { code: 'CANVAS_OPEN', canvasId: held.manifest.id, name: held.manifest.name } }
    }
    this.remove(held)
    return ok(undefined)
  }

  private setView(view: ViewWire): void {
    if (view.camera && this.canvases.has(view.camera.canvasId)) {
      this.opts.view.setCamera(view.camera.canvasId, view.camera.camera)
    }
    if (view.activeTab !== undefined && this.tabExists(view.activeTab) && this.opts.view.view.activeTab !== view.activeTab) {
      this.opts.view.setActiveTab(view.activeTab)
      this.opts.onChange({ kind: 'view' })
    }
  }
}
