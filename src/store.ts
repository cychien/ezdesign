import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  constants as fsConstants,
  copyFileSync,
  createWriteStream,
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
import type { Readable } from 'node:stream'
import { isVideoMime } from './attachment-policy.js'
import { ATTACHMENT_GRACE_MS, SESSIONS_DIR } from './constants.js'
import type { AcpConfigValue } from './acp-config.js'
import type { Camera, CanvasId, ShellView, TabId, ViewStore } from './canvas/types.js'
import type { Said } from './history.js'
import type { Initiator } from './dev-server/index.js'
import { rememberDesignHarness } from './preferences.js'
import type {
  Anchor,
  Annotation,
  Attachment,
  AttachmentOrigin,
  BatchView,
  ConversationEntry,
  ExploreState,
  ExploreStatus,
  ExploreVariant,
  FeedbackBatch,
  Reference,
  SessionEndedBy,
  VideoDigest,
  VideoFrames,
} from './protocol.js'
import type { VideoSettle, VideoStatusWire } from './attachment-wire.js'

/** Whether two anchors point at the same place on the page, for the one
 *  question that needs to know: can these two explore rounds both have their
 *  variant standing in a slot, or are they fighting over one.
 *
 *  `source` first, because `file:line` is the only identity here that survives a
 *  re-render. Without the build plugin there is only the selector, which is
 *  weaker - two rounds on structurally identical elements may be judged the same
 *  - and the cost of that is one selection cleared, not a wrong swap. */
/** How a round closes: with its variants under `status`, or - holding none -
 *  dismissed, off the strip and off the page. A round already dismissed stays so
 *  whatever it holds. */
function closeExplore(round: ExploreState, status: ExploreStatus): ExploreState {
  if (round.status === 'dismissed') return round
  return round.variants.length
    ? { ...round, status }
    : { ...round, status: 'dismissed', selected: null }
}

export function sameTarget(a: Anchor, b: Anchor): boolean {
  if (a.source && b.source) return a.source === b.source && a.text === b.text
  return !!a.selector && a.selector === b.selector
}

export function newId(): string {
  return randomBytes(6).toString('hex')
}

/** The project is the identity. Origin alone never was one - dev servers
 *  default to the same port, so two projects on `localhost:5173` would share a
 *  store - and origin + project made a dev server that moved from 5173 to 5174
 *  start a fresh review of the same project. The origin is a property of the
 *  session (`PersistedSession.app`), attachable later. Legacy `(origin,
 *  project)` directories are folded in by `session-migrate.ts`. */
export function sessionKey(project: string): string {
  return createHash('sha1').update(project).digest('hex').slice(0, 12)
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
}

function extensionFor(mime: string): string {
  const known = MIME_EXT[mime]
  if (known) return known
  const subtype = mime.split('/')[1] ?? ''
  return /^[a-z0-9]{1,8}$/.test(subtype) ? `.${subtype}` : ''
}

/** The stored filename is built from this, so it has to give up anything that
 *  could leave the attachments directory: separators first, then the leading
 *  dots that `..` and dotfiles are made of. Non-ASCII names survive - they are
 *  not dangerous, and a Chinese filename mangled to `file.png` is a worse
 *  outcome than one kept intact. */
export function sanitizeAttachmentName(raw: string, mime: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
  return cleaned || `file${extensionFor(mime)}`
}

/** A file name for a library item, built from what it is called. The stem is
 *  cut before the extension goes on, so the sanitizer's cap cannot take it off,
 *  and a title's slashes are kept as characters rather than read as a path. */
export function libraryAttachmentName(title: string, mime: string): string {
  const stem = title.replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 48).trim()
  return `${stem || 'reference'}${extensionFor(mime)}`
}

/** Clipboard screenshots all arrive as `image.png`, so a session would otherwise
 *  fill with chips the user cannot tell apart. */
function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

function isPendingVideo(a: Attachment): boolean {
  return a.video?.state === 'pending'
}

function sheetFileName(id: string, sheet: number): string {
  return `${id}.sheet-${sheet}.jpg`
}

function sheetNumbers(video: VideoFrames): number[] {
  return [1, ...video.motion.flatMap((m) => (m.sheet === null ? [] : [m.sheet]))]
}

function attachmentFiles(a: Attachment): string[] {
  const own = `${a.id}-${a.name}`
  return a.video?.state === 'ready' ? [own, ...sheetNumbers(a.video).map((n) => sheetFileName(a.id, n))] : [own]
}

function statusOf(a: Attachment): VideoStatusWire {
  const video = a.video
  if (!video || video.state === 'ready') return { state: 'ready' }
  if (video.state === 'failed') return { state: 'failed', reason: video.reason }
  return { state: 'pending' }
}

function digestOf(settle: VideoSettle): VideoDigest {
  if (settle.state === 'failed') return settle
  const { sheets: _, ...frames } = settle
  return frames
}

/** The dev server on the App tab. Not identity (see `sessionKey`): attached by
 *  `ezdesign <url>`, attached later to a session opened without one, and taken
 *  away when another project's session attaches the same origin. */
export type AppAttachment =
  | { kind: 'none' }
  | {
      kind: 'attached'
      origin: string
      /** When the user last ran `ezdesign <url>` for it. Written by that act
       *  alone - never by restore or a wake - so it cannot renew itself; restore
       *  hands a contested origin to the newest. */
      attachedAt: number
    }

export type AttachedApp = Extract<AppAttachment, { kind: 'attached' }>

/** `session.json`. A pre-project `(origin, project)` record has a string
 *  `targetOrigin` instead of `app`; `session-migrate.ts` folds those in, and an
 *  older daemon skips this shape because it requires `targetOrigin`. */
export interface PersistedSession {
  /** Absolute path of the project, by `projectRoot`. The identity. */
  project: string
  app: AppAttachment
  /** Rebuild this session at the next daemon start. Set when a runtime starts,
   *  cleared for every session only by the idle exit - the one exit nobody is
   *  watching - and left set by a crash, a stop, a version replacement or a
   *  self-update, the exits an open shell tab has to survive. Bounds restore by
   *  what was live, not by every project ever opened. */
  restoreOnStart?: true
  /** Legacy directory keys already folded into this one: a key listed here is
   *  never merged again, which makes the migration safe to re-run. */
  migratedFrom?: string[]
  state: 'active' | 'ended'
  endedBy?: SessionEndedBy
  createdAt: number
  /** Last port this session's proxy held. A restarted daemon re-binds it so the
   *  shell tab the user already has open survives a reload. */
  port?: number
  /** The ACP command this session's agent was started with. A restarted daemon
   *  spawns it again, so the review does not lose its agent along with the
   *  daemon - though it does lose the agent's context, which is what the shell
   *  is told. */
  agent?: string
  /** Which host's shell connected `agent`, so the app's quit still knows its own after a restore. */
  agentBy?: Initiator
  /** The user disconnected the agent here: opening the project does not connect one again. */
  agentDeclined?: boolean
  /** The agent-config picks the user made - model, effort, mode - keyed by the
   *  agent's own config ids. Re-asserted on every session this agent opens, so a
   *  `/new` or a daemon restart does not quietly hand the review back to the
   *  agent's default model. Only the user's own picks live here: see
   *  `AcpAgentOptions.onConfigChange`. */
  agentConfig?: Record<string, AcpConfigValue>
  /** The conversations this review has had, oldest first. A window onto the log,
   *  never a cut in it: the record stays whole on disk and the shell is shown one
   *  chat at a time, which is what "new chat" means to the person who asked for
   *  one - and what lets an earlier one be picked back up.
   *
   *  Written on first use, so a session recorded before chats existed gets one
   *  built from its `conversationClear`. */
  chats?: Chat[]
  /** Which of `chats` the shell is showing and the agent is on. */
  currentChatId?: string
  /** Per session, not per chat, so `/new` keeps it. */
  designHarness?: boolean
  /** Superseded by `chats`. Read once, to migrate; never written again. */
  conversationClear?: ConversationClear
}

/** One conversation: a window onto the log, and the ACP session that remembers
 *  it. */
export interface Chat {
  id: string
  /** The agent-side session backing this chat, once one is open. Absent on a
   *  chat that has never reached an agent, and replaced when the agent turns out
   *  not to have the old one any more. */
  acpSessionId?: string
  /** Which agent issued `acpSessionId`. A session id is only meaningful to the
   *  agent that made it - Claude keeps its conversations in one store and Codex
   *  in another, and neither can resolve the other's - so without this a review
   *  that changed agent would offer one of them the other's id and be told, at
   *  best, that no such session exists. */
  agent?: string
  startedAt: number
  /** The conversation this one was branched off, when it was. A branch carries
   *  the parent's history - the agent was handed a copy of it - but nothing said
   *  in the branch reaches the parent, which is the point: an explore can be
   *  talked about at length and the review still returns to where it forked
   *  from, carrying only what the user chose to take back. */
  parentChatId?: string
  /** Once handed, the earlier conversations are in the agent's context for good. */
  historyGivenAt?: number
  /** When harness instructions first reached this chat's agent; they stay in its context. */
  harnessSeenAt?: number
}

/** One chat, with what it takes to choose between them: when, how much, and
 *  whether it is the one showing. */
export interface ChatSummary {
  id: string
  startedAt: number
  entries: number
  current: boolean
  /** The ACP session this conversation ran on, when it ever ran one. What the
   *  agents' own names for it are keyed by - see `chat-titles.ts`. */
  acpSessionId?: string
  /** The agent it ran on, since each names its conversations in its own way. */
  agent?: string
  /** The first thing the user said in it, for a conversation no agent will name. */
  said?: string
  /** The conversation this one branched off, when it did. What the picker draws
   *  the indent from, and what 回主線 goes back to. */
  parentChatId?: string
}

export interface ConversationClear {
  /** Entries stamped at or after this are the new thread. */
  at: number
}

function isProjectSession(value: unknown): value is PersistedSession {
  const record = value as Partial<PersistedSession> & { targetOrigin?: unknown }
  return (
    typeof record?.project === 'string' &&
    typeof record.app?.kind === 'string' &&
    record.targetOrigin === undefined
  )
}

/** Every project session on disk. Legacy `(origin, project)` records are not
 *  listed: the migration folds them in before anything reads this, and one
 *  without a `project` stays inert, because guessing its project is the mix-up
 *  the key exists to prevent. */
export function listPersistedSessions(): PersistedSession[] {
  let keys: string[]
  try {
    keys = readdirSync(SESSIONS_DIR)
  } catch {
    return []
  }
  const sessions: PersistedSession[] = []
  for (const key of keys) {
    try {
      const raw = readFileSync(join(SESSIONS_DIR, key, 'session.json'), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isProjectSession(parsed)) sessions.push(parsed)
    } catch {
      /* half-written or foreign directory - skip it */
    }
  }
  return sessions
}

/** One project's record, read from its own directory - no listing. Null for a
 *  project with no session, or a record that is not of this shape. */
export function persistedSession(project: string): PersistedSession | null {
  try {
    const raw = readFileSync(join(SESSIONS_DIR, sessionKey(project), 'session.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isProjectSession(parsed) && parsed.project === project ? parsed : null
  } catch {
    return null
  }
}

const attachedAt = (s: PersistedSession): number =>
  s.app.kind === 'attached' ? s.app.attachedAt : -1

/** The sessions a starting daemon rebuilds: `active` and `restoreOnStart`,
 *  newest `app.attachedAt` first (unattached last). That is the order origins
 *  are handed out in by `SessionDirectory.restore`, so of two records naming
 *  one origin the one the user attached last keeps it. */
export function listRestorableSessions(): PersistedSession[] {
  return listPersistedSessions()
    .filter((s) => s.state === 'active' && s.restoreOnStart)
    .sort((a, b) => attachedAt(b) - attachedAt(a))
}

/**
 * Disk-backed state for one review session (one project). Files are tiny and
 * every mutation rewrites the file synchronously — queued feedback must survive
 * daemon restarts and crashes.
 */
export class SessionStore implements ViewStore {
  readonly dir: string

  constructor(readonly project: string) {
    this.dir = join(SESSIONS_DIR, sessionKey(project))
    mkdirSync(this.dir, { recursive: true })
    if (!this.readJson<PersistedSession>('session.json')) {
      this.writeJson('session.json', {
        project,
        app: { kind: 'none' },
        state: 'active',
        createdAt: Date.now(),
      } satisfies PersistedSession)
    }
  }

  // ------------------------------------------------------------------ origin

  get app(): AppAttachment {
    return this.session.app ?? { kind: 'none' }
  }

  /** The user ran `ezdesign <url>`: `at` becomes `attachedAt`, also when the
   *  origin is the one already attached. */
  attachApp(origin: string, at: number): void {
    this.patchSession({ app: { kind: 'attached', origin, attachedAt: at } })
  }

  /** Another project took the origin. `attachedAt` goes with it, so a restore
   *  cannot hand the origin back. Idempotent. */
  detachApp(): void {
    if (this.app.kind === 'none') return
    this.patchSession({ app: { kind: 'none' } })
  }

  setRestoreOnStart(on: boolean): void {
    const { restoreOnStart: was, ...rest } = this.session
    if (!!was === on) return
    this.writeJson('session.json', on ? { ...rest, restoreOnStart: true } : rest)
  }

  // -------------------------------------------------------------------- view

  /** `view.json`, beside `session.json` rather than in it: what the viewer is
   *  looking at, not what the review is, and a camera save should not rewrite
   *  the record every other mutator rewrites. */
  get view(): ShellView {
    return this.readJson<ShellView>('view.json') ?? {}
  }

  setActiveTab(tab: TabId): void {
    this.writeJson('view.json', { ...this.view, activeTab: tab })
  }

  setCamera(canvasId: CanvasId, camera: Camera): void {
    const view = this.view
    this.writeJson('view.json', { ...view, cameras: { ...view.cameras, [canvasId]: camera } })
  }

  /** A deleted canvas's camera has nothing left to look at. */
  forgetCamera(canvasId: CanvasId): void {
    const view = this.view
    if (!view.cameras?.[canvasId]) return
    const { [canvasId]: _gone, ...cameras } = view.cameras
    this.writeJson('view.json', { ...view, cameras })
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as T
    } catch {
      return null
    }
  }

  private writeJson(file: string, value: unknown): void {
    writeFileSync(join(this.dir, file), JSON.stringify(value, null, 2))
  }

  private patchSession(patch: Partial<PersistedSession>): void {
    this.writeJson('session.json', { ...this.session, ...patch })
  }

  get session(): PersistedSession {
    return this.readJson<PersistedSession>('session.json')!
  }

  get annotations(): Annotation[] {
    return this.readJson<Annotation[]>('queue.json') ?? []
  }

  get outbox(): FeedbackBatch[] {
    return this.readJson<FeedbackBatch[]>('outbox.json') ?? []
  }

  get conversation(): ConversationEntry[] {
    return this.readJson<ConversationEntry[]>('conversation.json') ?? []
  }

  // ------------------------------------------------------------------ explore

  /** Every round this review has had, oldest first, dismissed ones included -
   *  the thread still refers to them, and a dismissed round is history rather
   *  than a mistake. Callers that draw the strip filter them out. */
  get explores(): ExploreState[] {
    return this.readJson<ExploreState[]>('explores.json') ?? []
  }

  private writeExplores(explores: ExploreState[]): void {
    this.writeJson('explores.json', explores)
  }

  private patchExplore(id: string, patch: (e: ExploreState) => ExploreState): ExploreState | null {
    const explores = this.explores
    const found = explores.find((e) => e.id === id)
    if (!found) return null
    const next = patch(found)
    this.writeExplores(explores.map((e) => (e.id === id ? next : e)))
    return next
  }

  /** Open a round on one element.
   *
   *  Any live round already holding this element's place gives it up: two rounds
   *  cannot both have their variant standing in one slot, and the newer one is
   *  the one the user just asked for. Rounds on *other* elements are left alone,
   *  which is what lets a button and a heading be explored at once. */
  startExplore(
    round: Omit<ExploreState, 'status' | 'variants' | 'selected' | 'startedAt'>,
  ): ExploreState {
    if (round.attachments?.some(isPendingVideo)) throw new Error('a video still being digested cannot start an explore')
    const fresh: ExploreState = {
      ...round,
      status: 'generating',
      variants: [],
      selected: null,
      startedAt: Date.now(),
    }
    const explores = this.explores.map((e) =>
      e.selected && sameTarget(e.anchor, fresh.anchor) ? { ...e, selected: null } : e,
    )
    this.writeExplores([...explores, fresh])
    return fresh
  }

  /** What earlier rounds on this element already showed the user, oldest first and capped, so the
   *  next round can offer something else. */
  earlierVariants(round: ExploreState): { name: string; note?: string }[] {
    return this.explores
      .filter((e) => e.id !== round.id && sameTarget(e.anchor, round.anchor))
      .flatMap((e) => e.variants.map(({ name, note }) => (note ? { name, note } : { name })))
      .slice(-12)
  }

  /** Record a variant against a round that is still taking them. Null when the
   *  round is over or gone, which is how a late one is refused. */
  addVariant(id: string, variant: Omit<ExploreVariant, 'id' | 'createdAt'>): ExploreState | null {
    const round = this.explores.find((e) => e.id === id)
    if (!round || round.status !== 'generating') return null
    return this.patchExplore(id, (e) => ({
      ...e,
      variants: [...e.variants, { ...variant, id: newId(), createdAt: Date.now() }],
    }))
  }

  /** The round's turn is over, however it ended. What a closed round keeps is
   *  what had arrived, so one that ends holding nothing is dismissed outright:
   *  there is no variant to leave on the page and no reason for a tab. */
  endExplore(id: string, status: ExploreStatus): ExploreState | null {
    return this.patchExplore(id, (e) => closeExplore(e, status))
  }

  /** Bring every round into line with how rounds close now, on restore.
   *
   *  No turn survives the daemon, so a round still generating when its session
   *  comes back is over - cancelled, with whatever had arrived. Left alone it
   *  stayed generating for good, a strip saying 還在想 about an agent that was
   *  not. And a round closed by an earlier version holding nothing is dismissed
   *  the way `endExplore` would dismiss it today, so the strip is not carrying
   *  tabs for rounds that were empty before the rule existed. */
  settleExplores(): void {
    const explores = this.explores
    const settled = explores.map((e) =>
      closeExplore(e, e.status === 'generating' ? 'cancelled' : e.status),
    )
    if (settled.some((e, i) => e.status !== explores[i]!.status)) this.writeExplores(settled)
  }

  /** The round is taking variants again, because a turn is about to run in the
   *  branch it belongs to. Not `endExplore`'s inverse: that one *settles* a round,
   *  and settling one that holds nothing dismisses it outright. A dismissed round
   *  is past reviving - nothing of it is on the page and its url is gone. */
  resumeExplore(id: string): ExploreState | null {
    return this.patchExplore(id, (e) =>
      e.status === 'dismissed' ? e : { ...e, status: 'generating' },
    )
  }

  /** Put one of a round's variants on the page, or `null` for the original.
   *  Refused for a variant the round does not have, so the page can never be
   *  asked to show markup nothing recorded. */
  selectVariant(id: string, variantId: string | null): ExploreState | null {
    const round = this.explores.find((e) => e.id === id)
    if (!round) return null
    if (variantId !== null && !round.variants.some((v) => v.id === variantId)) return null
    return this.patchExplore(id, (e) => ({ ...e, selected: variantId }))
  }

  /** Close a round: nothing of it is on the page any more, and its url stops
   *  taking variants. Kept in the list, because the thread refers to it. */
  dismissExplore(id: string): ExploreState | null {
    return this.patchExplore(id, (e) => ({ ...e, status: 'dismissed', selected: null }))
  }

  markExploreAdopted(id: string, variantId: string): ExploreState | null {
    return this.patchExplore(id, (e) => ({ ...e, adopted: variantId }))
  }

  addAnnotation(a: Annotation): void {
    this.writeJson('queue.json', [...this.annotations, a])
  }

  /** Files dropped by an edit are deliberately left on disk: `sweepAttachments`
   *  is what collects an unreferenced attachment, and deleting eagerly here would
   *  make saving a comment destroy bytes the user cannot see they are losing.
   *  `removeAnnotation` drops them because the annotation itself is gone. */
  updateAnnotation(
    id: string,
    patch: Partial<Pick<Annotation, 'comment' | 'attachments' | 'references'>>,
  ): boolean {
    const list = this.annotations
    const target = list.find((a) => a.id === id)
    if (!target) return false
    // Assigned key by key, dropping the empty ones: an `Object.assign` of a patch
    // holding `comment: undefined` would blank the comment rather than leave it,
    // and an empty `attachments: []` should mean the field is gone, not present
    // and empty - that is the shape `addAnnotation` writes.
    if (patch.comment !== undefined) target.comment = patch.comment
    if (patch.attachments !== undefined) {
      if (patch.attachments.length) target.attachments = patch.attachments
      else delete target.attachments
    }
    if (patch.references !== undefined) {
      if (patch.references.length) target.references = patch.references
      else delete target.references
    }
    this.writeJson('queue.json', list)
    return true
  }

  removeAnnotation(id: string): boolean {
    const list = this.annotations
    const target = list.find((a) => a.id === id)
    if (!target) return false
    this.writeJson(
      'queue.json',
      list.filter((a) => a.id !== id),
    )
    // After the queue write, so a crash in between leaves an orphan file for the
    // sweep rather than an annotation pointing at bytes that are already gone.
    this.dropAttachments(target.attachments)
    return true
  }

  /** Move the queue (+ optional note and its files) into a sealed batch awaiting
   *  agent pickup. Attachment bytes stay put - the batch now references them. */
  sendBatch(
    note: string | null,
    attachments: Attachment[] = [],
    references: Reference[] = [],
    skills: string[] = [],
    view?: BatchView,
  ): FeedbackBatch | null {
    if (this.holdsPendingVideo(attachments)) throw new Error('a video still being digested cannot be sent')
    const items = this.annotations
    // A skill on its own is a batch: "run this over what you can see" is a
    // request, even with nothing annotated and nothing typed.
    if (
      items.length === 0 &&
      !note?.trim() &&
      attachments.length === 0 &&
      references.length === 0 &&
      skills.length === 0
    ) {
      return null
    }
    const batch: FeedbackBatch = {
      batchId: newId(),
      items,
      note: note?.trim() || null,
      ...(attachments.length ? { attachments } : {}),
      ...(references.length ? { references } : {}),
      ...(skills.length ? { skills } : {}),
      ...(view ? { view } : {}),
      sentAt: Date.now(),
    }
    this.writeJson('outbox.json', [...this.outbox, batch])
    this.writeJson('queue.json', [])
    return batch
  }

  /** Through the outbox so it waits its turn; the annotation queue is left alone. */
  sendSetup(): FeedbackBatch {
    const batch: FeedbackBatch = {
      batchId: newId(),
      items: [],
      note: null,
      setup: true,
      sentAt: Date.now(),
    }
    this.writeJson('outbox.json', [...this.outbox, batch])
    return batch
  }

  /** A branch was handed its parent's transcript, so the parent's exposure counts. */
  harnessSeen(): boolean {
    const chats = this.chats
    const seen = new Set<string>()
    for (
      let chat: Chat | undefined = this.currentChat;
      chat && !seen.has(chat.id);
      chat = chats.find((c) => c.id === chat!.parentChatId)
    ) {
      if (chat.harnessSeenAt) return true
      seen.add(chat.id)
    }
    return false
  }

  markHarnessSeen(): void {
    const current = this.currentChat
    if (current.harnessSeenAt) return
    this.patchSession({
      chats: this.chats.map((c) => (c.id === current.id ? { ...c, harnessSeenAt: Date.now() } : c)),
    })
  }

  /** Only undelivered ones: a setup turn already running is the agent's to finish. */
  settleUndeliveredSetup(): string[] {
    const outbox = this.outbox
    const now = Date.now()
    const settled: string[] = []
    for (const batch of outbox) {
      if (batch.setup && !batch.deliveredAt && !batch.ackedAt) {
        batch.ackedAt = now
        settled.push(batch.batchId)
      }
    }
    if (settled.length) this.writeJson('outbox.json', outbox)
    return settled
  }

  // -------------------------------------------------------------- attachments

  get attachmentsDir(): string {
    return join(this.dir, 'attachments')
  }

  /** id → metadata for every attachment held by this session, including ones no
   *  annotation references yet because the user is still typing. */
  get attachmentIndex(): Record<string, Attachment> {
    return this.readJson<Record<string, Attachment>>('attachments.json') ?? {}
  }

  attachmentPath(a: Pick<Attachment, 'id' | 'name'>): string {
    return join(this.attachmentsDir, `${a.id}-${a.name}`)
  }

  sheetPath(a: Pick<Attachment, 'id'>, sheet: number): string {
    return join(this.attachmentsDir, sheetFileName(a.id, sheet))
  }

  addAttachment(rawName: string, mime: string, bytes: Buffer): Attachment {
    return this.storeAttachment(newId(), rawName, mime, bytes.byteLength, (path) => writeFileSync(path, bytes))
  }

  async receiveAttachment(
    rawName: string,
    mime: string,
    body: Readable,
    limit: number,
  ): Promise<Attachment | 'too-large' | 'empty'> {
    const id = newId()
    mkdirSync(this.attachmentsDir, { recursive: true })
    const part = join(this.attachmentsDir, `${id}.part`)
    const out = createWriteStream(part)
    let size = 0
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        size += chunk.byteLength
        if (size > limit) break
        if (!out.write(chunk)) await once(out, 'drain')
      }
      out.end()
      await once(out, 'close')
    } catch (error) {
      out.destroy()
      rmSync(part, { force: true })
      throw error
    }
    if (size > limit || size === 0) {
      rmSync(part, { force: true })
      return size === 0 ? 'empty' : 'too-large'
    }
    return this.storeAttachment(id, rawName, mime, size, (path) => renameSync(part, path))
  }

  /** A copy, not a link to the library's file: a session owns its attachments
   *  outright, and the sweep deletes them. A clone where the filesystem has one. */
  copyAttachment(title: string, mime: string, from: string, origin: AttachmentOrigin): Attachment {
    return this.storeAttachment(
      newId(),
      libraryAttachmentName(title, mime),
      mime,
      statSync(from).size,
      (path) => copyFileSync(from, path, fsConstants.COPYFILE_FICLONE),
      origin,
    )
  }

  private storeAttachment(
    id: string,
    rawName: string,
    mime: string,
    size: number,
    write: (path: string) => void,
    origin?: AttachmentOrigin,
  ): Attachment {
    const index = this.attachmentIndex
    const taken = new Set(Object.values(index).map((a) => a.name))
    const attachment: Attachment = {
      id,
      name: dedupeName(sanitizeAttachmentName(rawName, mime), taken),
      mime,
      size,
      createdAt: Date.now(),
      ...(origin ? { origin } : {}),
      ...(isVideoMime(mime) ? { video: { state: 'pending' as const } } : {}),
    }
    mkdirSync(this.attachmentsDir, { recursive: true })
    // Bytes before index: an index entry pointing at no file would break every
    // reader, while a file no entry names is just something for the sweep.
    write(this.attachmentPath(attachment))
    this.writeJson('attachments.json', { ...index, [attachment.id]: attachment })
    return attachment
  }

  /** Null when any id is unknown - a partial resolution would silently drop a
   *  file the user watched themselves attach. */
  getAttachments(ids: string[]): Attachment[] | null {
    const index = this.attachmentIndex
    const found: Attachment[] = []
    for (const id of ids) {
      const a = index[id]
      if (!a) return null
      found.push(a)
    }
    return found
  }

  get pendingVideoIds(): string[] {
    return Object.values(this.attachmentIndex).flatMap((a) => (isPendingVideo(a) ? [a.id] : []))
  }

  holdsPendingVideo(extra: readonly Attachment[] = []): boolean {
    return [...extra, ...this.annotations.flatMap((a) => a.attachments ?? [])].some(isPendingVideo)
  }

  settleVideo(id: string, settle: VideoSettle): VideoStatusWire {
    const index = this.attachmentIndex
    const entry = index[id]
    if (!entry) return { state: 'gone' }
    if (!isPendingVideo(entry)) return statusOf(entry)
    if (settle.state === 'ready') {
      settle.sheets.forEach((bytes, i) => writeFileSync(this.sheetPath(entry, i + 1), bytes))
    }
    const settled: Attachment = { ...entry, video: digestOf(settle) }
    this.writeJson('attachments.json', { ...index, [id]: settled })
    const queue = this.annotations
    if (queue.some((a) => a.attachments?.some((x) => x.id === id))) {
      this.writeJson(
        'queue.json',
        queue.map((a) => (a.attachments ? { ...a, attachments: a.attachments.map((x) => (x.id === id ? settled : x)) } : a)),
      )
    }
    return statusOf(settled)
  }

  removeAttachment(id: string): 'ok' | 'referenced' | 'unknown' {
    const index = this.attachmentIndex
    const target = index[id]
    if (!target) return 'unknown'
    if (this.referencedAttachmentIds().has(id)) return 'referenced'
    this.dropAttachments([target])
    return 'ok'
  }

  /** Deletes files and index entries outright. Callers own the check that
   *  nothing still references them. */
  private dropAttachments(list: Attachment[] | undefined): void {
    if (!list?.length) return
    const index = this.attachmentIndex
    for (const a of list) {
      for (const name of attachmentFiles(a)) {
        try {
          unlinkSync(join(this.attachmentsDir, name))
        } catch {
          /* already gone - the index entry is still worth dropping */
        }
      }
      delete index[a.id]
    }
    this.writeJson('attachments.json', index)
  }

  private referencedAttachmentIds(): Set<string> {
    const ids = new Set<string>()
    const take = (list?: Attachment[]) => {
      for (const a of list ?? []) ids.add(a.id)
    }
    for (const a of this.annotations) take(a.attachments)
    for (const batch of this.outbox) {
      take(batch.attachments)
      for (const item of batch.items) take(item.attachments)
    }
    for (const round of this.explores) take(round.attachments)
    return ids
  }

  /** Drops attachments nothing references and nothing is plausibly still
   *  composing. Runs at session start rather than on send: a sweep must never
   *  race a composer that is holding freshly uploaded ids, and the grace window
   *  is what buys that safety without any coordination. */
  sweepAttachments(now = Date.now()): void {
    const cutoff = now - ATTACHMENT_GRACE_MS
    const referenced = this.referencedAttachmentIds()
    const index = this.attachmentIndex
    const doomed = Object.values(index).filter((a) => !referenced.has(a.id) && a.createdAt < cutoff)
    this.dropAttachments(doomed)

    // Files written before the crash that stopped their index entry. Nothing
    // will ever name them, so age is the only thing that can decide.
    const kept = new Set(Object.values(this.attachmentIndex).flatMap(attachmentFiles))
    let entries: string[]
    try {
      entries = readdirSync(this.attachmentsDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (kept.has(name)) continue
      const path = join(this.attachmentsDir, name)
      try {
        if (statSync(path).mtimeMs >= cutoff) continue
        unlinkSync(path)
      } catch {
        /* raced with another sweep or a manual delete */
      }
    }
  }

  /** Oldest batch not yet acked. Redelivers delivered-but-unacked batches (at-least-once). */
  nextBatch(): FeedbackBatch | null {
    return this.outbox.find((b) => !b.ackedAt) ?? null
  }

  /** Batches handed out but never acked - what an ACP turn's end settles. At most
   *  one at a time: `nextBatch` only ever hands out the oldest unacked. */
  deliveredBatchIds(): string[] {
    return this.outbox.filter((b) => b.deliveredAt && !b.ackedAt).map((b) => b.batchId)
  }

  /** Everything the agent has not finished with - the one it is on, and the ones
   *  still waiting behind it. What `/new` settles: a fresh session is not going to
   *  answer questions the user has just said to start over from. */
  pendingBatchIds(): string[] {
    return this.outbox.filter((b) => !b.ackedAt).map((b) => b.batchId)
  }

  markDelivered(batchId: string): void {
    const outbox = this.outbox
    const batch = outbox.find((b) => b.batchId === batchId)
    if (batch && !batch.deliveredAt) {
      batch.deliveredAt = Date.now()
      this.writeJson('outbox.json', outbox)
    }
  }

  ack(batchId: string): void {
    const outbox = this.outbox
    const batch = outbox.find((b) => b.batchId === batchId)
    if (batch && !batch.ackedAt) {
      batch.ackedAt = Date.now()
      this.writeJson('outbox.json', outbox)
    }
  }

  /** Stamped with the chat it was written during, which is what lets the window
   *  be a filter rather than a time range - an earlier chat picked back up goes
   *  on collecting entries stamped later than the chat that followed it. */
  appendConversation(entry: ConversationEntry): void {
    const stamped: ConversationEntry = { chatId: this.currentChat.id, ...entry }
    this.writeJson('conversation.json', [...this.conversation, stamped])
  }

  setPort(port: number): void {
    this.patchSession({ port })
  }

  setAgent(command: string): void {
    this.patchSession({ agent: command })
  }

  setAgentBy(by: Initiator): void {
    const { agentDeclined: _agentDeclined, ...rest } = this.session
    this.writeJson('session.json', { ...rest, agentBy: by })
  }

  declineAgent(): void {
    this.patchSession({ agentDeclined: true })
  }

  /** A restore brings back only an agent still connected when the daemon stopped. */
  clearAgent(): void {
    const { agent: _agent, agentBy: _agentBy, ...rest } = this.session
    this.writeJson('session.json', rest)
  }

  /** Remember one of the user's agent-config picks - the model, and anything else
   *  the agent offers - so the next session opens on it. */
  setAgentConfig(configId: string, value: AcpConfigValue): void {
    this.patchSession({ agentConfig: { ...this.session.agentConfig, [configId]: value } })
  }

  /** Ending drops the agent with the session: a reopen decides afresh whether
   *  it is ACP-driven, and a restore must not resurrect an agent nobody asked for.
   *  The picks go with it - they described that agent's options, and the next one
   *  need not have them. */
  end(by: SessionEndedBy): void {
    const { agent: _agent, agentBy: _agentBy, agentDeclined: _agentDeclined, agentConfig: _agentConfig, ...rest } = this.session
    this.writeJson('session.json', { ...rest, state: 'ended', endedBy: by })
  }

  /** This review's conversations, oldest first, with one guaranteed to exist.
   *
   *  Built on demand rather than at session creation so a store recorded before
   *  chats existed grows one: its `conversationClear` becomes the first chat's
   *  `startedAt`, which is the same window under a new name. */
  get chats(): Chat[] {
    const session = this.session
    if (session.chats?.length) return session.chats
    const chats: Chat[] = [
      { id: newId(), startedAt: session.conversationClear?.at ?? session.createdAt },
    ]
    this.patchSession({ chats, currentChatId: chats[0]!.id })
    return chats
  }

  /** The conversation the shell is showing and the agent is on. */
  get currentChat(): Chat {
    const chats = this.chats
    const id = this.session.currentChatId
    return chats.find((c) => c.id === id) ?? chats[chats.length - 1]!
  }

  /** Begin a conversation. Nothing is deleted: the log keeps every word, and only
   *  the window moves. */
  startChat(): Chat {
    const chat: Chat = { id: newId(), startedAt: Date.now() }
    this.patchSession({ chats: [...this.chats, chat], currentChatId: chat.id })
    return chat
  }

  /** Begin a conversation branched off the current one.
   *
   *  Unlike `startChat`, this one is born knowing its session: the agent has
   *  already copied the transcript into `acpSessionId`, and recording it here is
   *  what makes the reopen that follows a *resume of the copy* rather than a
   *  fresh start. The order matters - the store moves first, because what the
   *  agent opens is read back off it. */
  startBranch(acpSessionId: string | undefined, agent: string | undefined): Chat {
    const chat: Chat = {
      id: newId(),
      startedAt: Date.now(),
      parentChatId: this.currentChat.id,
      ...(acpSessionId && agent ? { acpSessionId, agent } : {}),
    }
    this.patchSession({ chats: [...this.chats, chat], currentChatId: chat.id })
    return chat
  }

  /** Show an earlier conversation and put the agent back on it. */
  /** The conversation a chain of branches grew from. */
  mainLineOf(id: string): string {
    const chats = this.chats
    const seen = new Set<string>()
    let chat = chats.find((c) => c.id === id)
    while (chat?.parentChatId && !seen.has(chat.id)) {
      seen.add(chat.id)
      chat = chats.find((c) => c.id === chat!.parentChatId)
    }
    return chat?.id ?? id
  }

  /** A branch whose explore rounds are all over has nothing left to do; only explore makes them. */
  spentBranch(): boolean {
    const current = this.currentChat
    if (!current.parentChatId) return false
    const rounds = this.explores.filter((e) => e.chatId === current.id)
    return rounds.length > 0 && rounds.every((e) => e.status === 'dismissed')
  }

  switchChat(id: string): Chat | null {
    const chat = this.chats.find((c) => c.id === id)
    if (!chat) return null
    this.patchSession({ currentChatId: chat.id })
    return chat
  }

  /** Record the agent-side session now backing the current chat, and which agent
   *  issued it. Replaces what was there: a resume the agent could not honour
   *  leaves the chat on a different session than it started with, and the old id
   *  names nothing. */
  setChatSession(acpSessionId: string, agent: string): void {
    const current = this.currentChat
    this.patchSession({
      chats: this.chats.map((c) => (c.id === current.id ? { ...c, acpSessionId, agent } : c)),
    })
  }

  get designHarness(): boolean {
    return this.session.designHarness === true
  }

  /** The user's switch, remembered for the project across sessions. */
  setDesignHarness(on: boolean): void {
    this.patchSession({ designHarness: on })
    rememberDesignHarness(this.project, on)
  }

  /** A state derived at start, not chosen, so the project's remembered choice is left alone. */
  restoreDesignHarness(on: boolean): void {
    if (on !== this.designHarness) this.patchSession({ designHarness: on })
  }

  setupPending(): boolean {
    return this.outbox.some((b) => b.setup && !b.ackedAt)
  }

  /** The session to ask this agent to resume, if the current chat has one *it*
   *  issued. A chat from another agent has an id that agent cannot resolve, so
   *  the honest answer is nothing and a fresh session. */
  resumableSessionId(agent: string): string | undefined {
    const chat = this.currentChat
    return chat.agent === agent ? chat.acpSessionId : undefined
  }

  /** Whether one logged entry belongs to one chat.
   *
   *  Two rules, because the log outlived the change. An entry stamped with a chat
   *  belongs to that chat. An entry from before stamping belongs to the first
   *  chat, gated by its `startedAt` - which is the `conversationClear` it was
   *  migrated from, so an old session draws exactly what it drew before.
   *
   *  One predicate, used by both the thread window and the chat list: they were
   *  written twice once, and the copy disagreeing with the original is how a
   *  conversation comes to be counted as empty while its thread is on screen. */
  private belongsTo(entry: ConversationEntry, chat: Chat, isFirst: boolean): boolean {
    return entry.chatId === undefined
      ? isFirst && entry.ts >= chat.startedAt
      : entry.chatId === chat.id
  }

  /** Excludes this chat and the chain it branched from: the agent has those transcripts. */
  /** What the user wrote themselves, newest first: each batch's note and comments. The rest of a
   *  user entry - a setup, an explore - is worded by the shell. */
  userWords(): string[] {
    const words: string[] = []
    const log = this.conversation
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i]!
      if (entry.role !== 'user' || !entry.items) continue
      for (const said of [entry.text, ...entry.items.map((item) => item.comment)]) {
        if (said?.trim()) words.push(said)
      }
    }
    return words
  }

  earlierChatsSaid(): Said[] {
    const chats = this.chats
    const firstId = chats[0]?.id
    const seen = new Set<string>()
    for (
      let chat: Chat | undefined = this.currentChat;
      chat && !seen.has(chat.id);
      chat = chats.find((c) => c.id === chat!.parentChatId)
    ) {
      seen.add(chat.id)
    }
    const known = chats.filter((c) => seen.has(c.id))
    const said: Said[] = []
    const log = this.conversation
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i]!
      if (entry.role !== 'user') continue
      if (known.some((chat) => this.belongsTo(entry, chat, chat.id === firstId))) continue
      for (const item of entry.items ?? []) {
        const comment = item.comment?.trim()
        if (comment) said.push({ where: item.where, said: comment })
      }
      const note = entry.text?.trim()
      if (note) said.push({ said: note })
    }
    return said
  }

  markHistoryGiven(): void {
    const current = this.currentChat
    this.patchSession({
      chats: this.chats.map((c) =>
        c.id === current.id ? { ...c, historyGivenAt: Date.now() } : c,
      ),
    })
  }

  /** The thread as the shell should draw it: the current chat, and nothing else. */
  get visibleConversation(): ConversationEntry[] {
    const current = this.currentChat
    const isFirst = this.chats[0]?.id === current.id
    return this.conversation.filter((entry) => this.belongsTo(entry, current, isFirst))
  }

  /** Every chat with enough about it to be chosen between, oldest first.
   *
   *  Every one, including a chat nothing has been said in yet: the caller reads
   *  "an earlier conversation is showing" off the current chat's position in this
   *  list, so dropping an empty newer one would make an older one look like the
   *  newest and take that signal away in the one state it exists to report. */
  chatSummaries(): ChatSummary[] {
    const chats = this.chats
    const current = this.currentChat.id
    const firstId = chats[0]?.id
    const log = this.conversation
    return chats.map((chat) => {
      const mine = log.filter((entry) => this.belongsTo(entry, chat, chat.id === firstId))
      const said = mine.find(
        (entry) =>
          entry.role === 'user' &&
          (entry.text?.trim() || entry.items?.some((item) => item.comment?.trim())),
      )
      return {
        id: chat.id,
        startedAt: chat.startedAt,
        entries: mine.length,
        current: chat.id === current,
        ...(chat.acpSessionId ? { acpSessionId: chat.acpSessionId } : {}),
        ...(chat.agent ? { agent: chat.agent } : {}),
        ...(chat.parentChatId ? { parentChatId: chat.parentChatId } : {}),
        ...(said
          ? {
              said:
                said.text?.trim() ||
                said.items?.find((item) => item.comment?.trim())?.comment?.trim(),
            }
          : {}),
      }
    })
  }

  /** Whether the newest chat is showing and has nothing in it - i.e. the review
   *  is already on a fresh conversation, and being asked for one again has
   *  nothing to do. */
  get onEmptyNewestChat(): boolean {
    const summaries = this.chatSummaries()
    const last = summaries[summaries.length - 1]
    return !!last?.current && last.entries === 0
  }

  reopen(): void {
    const { endedBy: _endedBy, ...rest } = this.session
    this.writeJson('session.json', { ...rest, state: 'active' })
  }
}
