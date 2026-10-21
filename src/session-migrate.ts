/** Folds the pre-project `(origin, project)` session directories into project
 *  sessions (`sessions/<sessionKey(project)>`), losing nothing queued, sent or
 *  said.
 *
 *  Before the re-key a project got a new directory for every dev-server port it
 *  was reviewed on (5173, then 5174 when vite moved), so one project can own
 *  several. Runs in the daemon before restore and before any control request is
 *  answered, on every start whose predecessor is gone.
 *
 *  The rules, all in the pure `mergeLegacySessions`:
 *  - Group by exact `project`. A record without one stays where it is, inert:
 *    guessing its project is the mix-up the key exists to prevent.
 *  - Import sources in `(createdAt, key)` order, after any project session that
 *    already exists.
 *  - Queue, outbox, conversation, chats, explores and attachments are merged by
 *    id. An id already taken by an earlier source is remapped, deterministically
 *    from `(sourceKey, oldId)`, and every reference to it in that source is
 *    rewritten, so nothing is dropped by a collision.
 *  - With no project session yet, the newest `active` source supplies `port`,
 *    `agent`, `agentConfig`, `currentChatId` and the attached origin, with its
 *    `createdAt` as `attachedAt`. `state` is active if any source was, and then
 *    `restoreOnStart` is set too: the daemon before the upgrade restored active
 *    sessions, so the first one after it does as well. An existing project
 *    session is newer than every legacy record, so its own fields win.
 *
 *  The fs shell (`migrateLegacySessions`) makes it crash-safe and idempotent:
 *  build under `<key>.staging-<pid>`, swap in by rename (an existing `<key>` goes
 *  to `<key>.prev-<pid>` and is removed after), record the folded directories in
 *  `migratedFrom`, then move each legacy directory to `LEGACY_SESSIONS_DIR` -
 *  never delete it. */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { LEGACY_SESSIONS_DIR, SESSIONS_DIR } from './constants.js'
import type { AcpConfigValue } from './acp-config.js'
import { type Chat, type ConversationClear, type PersistedSession, sessionKey } from './store.js'
import type {
  Annotation,
  Attachment,
  ConversationEntry,
  ExploreState,
  FeedbackBatch,
  SessionEndedBy,
} from './protocol.js'

/** `session.json` as versions before the re-key wrote it. Its own type, so
 *  nothing new reads `targetOrigin` by accident. */
export interface LegacySession {
  targetOrigin: string
  /** Absent on records older than `project` itself: those stay inert. */
  project?: string
  state: 'active' | 'ended'
  endedBy?: SessionEndedBy
  createdAt: number
  port?: number
  agent?: string
  agentConfig?: Record<string, AcpConfigValue>
  chats?: Chat[]
  currentChatId?: string
  designHarness?: boolean
  conversationClear?: ConversationClear
}

/** Everything one session directory holds, parsed. */
export interface SessionFiles<S> {
  key: string
  session: S
  queue: Annotation[]
  outbox: FeedbackBatch[]
  conversation: ConversationEntry[]
  explores: ExploreState[]
  attachmentIndex: Record<string, Attachment>
}

export type LegacyFiles = SessionFiles<LegacySession & { project: string }>
export type ProjectFiles = SessionFiles<PersistedSession>

/** A legacy directory as `migratedFrom` names it. The key alone is not enough:
 *  an older daemon run after the upgrade writes a new directory under the same
 *  key, and that one has not been folded in yet. */
export const legacyStamp = (key: string, createdAt: number): string => `${key}@${createdAt}`

const IDS = ['annotation', 'batch', 'chat', 'explore', 'attachment'] as const
type IdKind = (typeof IDS)[number]

/** The ids one source's records are re-keyed under. Identity for an id nothing
 *  earlier took; for a taken one, `sha1(sourceKey + '\n' + oldId).slice(0, 12)`,
 *  so the same input always remaps the same way. */
export type IdRemap = Record<IdKind, (sourceKey: string, oldId: string) => string>

/** An attachment file to copy into the merged directory: from the legacy
 *  `attachments/<oldId>-<name>` to `attachments/<newId>-<name>`. Copied, never
 *  moved: the legacy directory stays a complete backup. */
export interface AttachmentCopy {
  sourceKey: string
  from: { id: string; name: string }
  to: { id: string; name: string }
}

export interface MergedSession {
  files: ProjectFiles
  copies: AttachmentCopy[]
  /** The legacy directories this merge folded in, already appended to
   *  `files.session.migratedFrom`. */
  folded: string[]
}

const hashId = (seed: string): string => createHash('sha1').update(seed).digest('hex').slice(0, 12)

/** A legacy record from before chats is shown one chat built from its
 *  `conversationClear`, and its unstamped entries belong to that chat by date.
 *  Once merged, "the first chat" is some other source's, so both are made
 *  explicit here: the chat gets an id, and every unstamped entry is stamped with
 *  it when inside its window, else with a chat nothing has, which keeps hidden
 *  history hidden. */
function stampChats<S extends { createdAt: number; chats?: Chat[]; currentChatId?: string; conversationClear?: ConversationClear }>(
  files: SessionFiles<S>,
): SessionFiles<S> {
  const chats: Chat[] = files.session.chats?.length
    ? files.session.chats
    : [
        {
          id: hashId(`${files.key}\nchat`),
          startedAt: files.session.conversationClear?.at ?? files.session.createdAt,
        },
      ]
  const first = chats[0]!
  const hidden = hashId(`${files.key}\nhidden`)
  return {
    ...files,
    session: {
      ...files.session,
      chats,
      currentChatId: files.session.currentChatId ?? chats[chats.length - 1]!.id,
    },
    conversation: files.conversation.map((entry) =>
      entry.chatId !== undefined
        ? entry
        : { ...entry, chatId: entry.ts >= first.startedAt ? first.id : hidden },
    ),
  }
}

function idsOf(files: SessionFiles<{ chats?: Chat[]; currentChatId?: string }>): Record<IdKind, Set<string>> {
  const ids = Object.fromEntries(IDS.map((kind) => [kind, new Set<string>()])) as Record<
    IdKind,
    Set<string>
  >
  const takeAttachments = (list?: Attachment[]) => {
    for (const a of list ?? []) ids.attachment.add(a.id)
  }
  const takeAnnotation = (a: Annotation) => {
    ids.annotation.add(a.id)
    takeAttachments(a.attachments)
  }
  for (const a of files.queue) takeAnnotation(a)
  for (const batch of files.outbox) {
    ids.batch.add(batch.batchId)
    for (const item of batch.items) takeAnnotation(item)
    takeAttachments(batch.attachments)
  }
  for (const entry of files.conversation) {
    if (entry.batchId) ids.batch.add(entry.batchId)
    if (entry.chatId) ids.chat.add(entry.chatId)
  }
  for (const chat of files.session.chats ?? []) {
    ids.chat.add(chat.id)
    if (chat.parentChatId) ids.chat.add(chat.parentChatId)
  }
  if (files.session.currentChatId) ids.chat.add(files.session.currentChatId)
  for (const round of files.explores) {
    ids.explore.add(round.id)
    ids.chat.add(round.chatId)
    takeAttachments(round.attachments)
  }
  for (const id of Object.keys(files.attachmentIndex)) ids.attachment.add(id)
  return ids
}

/** Every id each source would bring, checked against those already taken by
 *  `existing` and by earlier sources in import order. `sources` must already
 *  be in that order. */
export function planIdRemap(
  existing: ProjectFiles | null,
  sources: readonly LegacyFiles[],
): IdRemap {
  const taken = Object.fromEntries(IDS.map((kind) => [kind, new Set<string>()])) as Record<
    IdKind,
    Set<string>
  >
  if (existing) {
    const own = idsOf(existing)
    for (const kind of IDS) for (const id of own[kind]) taken[kind].add(id)
  }
  const plans = new Map<string, Record<IdKind, Map<string, string>>>()
  for (const source of sources) {
    const own = idsOf(source)
    const plan = Object.fromEntries(IDS.map((kind) => [kind, new Map<string, string>()])) as Record<
      IdKind,
      Map<string, string>
    >
    for (const kind of IDS) {
      for (const id of own[kind]) {
        let next = id
        for (let n = 0; taken[kind].has(next); n++) {
          next = hashId(n === 0 ? `${source.key}\n${id}` : `${source.key}\n${id}\n${n}`)
        }
        taken[kind].add(next)
        plan[kind].set(id, next)
      }
    }
    plans.set(source.key, plan)
  }
  return Object.fromEntries(
    IDS.map((kind) => [
      kind,
      (sourceKey: string, oldId: string) => plans.get(sourceKey)?.[kind].get(oldId) ?? oldId,
    ]),
  ) as IdRemap
}

/** One source's records with every id and reference put through `remap`. */
function rewrite(source: LegacyFiles, remap: IdRemap): { files: LegacyFiles; copies: AttachmentCopy[] } {
  const k = source.key
  const attachment = (a: Attachment): Attachment => ({ ...a, id: remap.attachment(k, a.id) })
  const attachments = (list?: Attachment[]) => (list ? list.map(attachment) : list)
  const annotation = (a: Annotation): Annotation => ({
    ...a,
    id: remap.annotation(k, a.id),
    ...(a.attachments ? { attachments: attachments(a.attachments) } : {}),
  })
  const chat = (c: Chat): Chat => ({
    ...c,
    id: remap.chat(k, c.id),
    ...(c.parentChatId ? { parentChatId: remap.chat(k, c.parentChatId) } : {}),
  })
  const attachmentIndex: Record<string, Attachment> = {}
  const copies: AttachmentCopy[] = []
  for (const [id, a] of Object.entries(source.attachmentIndex)) {
    const moved = attachment({ ...a, id })
    attachmentIndex[moved.id] = moved
    copies.push({ sourceKey: k, from: { id, name: a.name }, to: { id: moved.id, name: a.name } })
  }
  return {
    copies,
    files: {
      key: k,
      session: {
        ...source.session,
        chats: source.session.chats?.map(chat),
        ...(source.session.currentChatId
          ? { currentChatId: remap.chat(k, source.session.currentChatId) }
          : {}),
      },
      queue: source.queue.map(annotation),
      outbox: source.outbox.map((batch) => ({
        ...batch,
        batchId: remap.batch(k, batch.batchId),
        items: batch.items.map(annotation),
        ...(batch.attachments ? { attachments: attachments(batch.attachments) } : {}),
      })),
      conversation: source.conversation.map((entry) => ({
        ...entry,
        ...(entry.batchId ? { batchId: remap.batch(k, entry.batchId) } : {}),
        ...(entry.chatId ? { chatId: remap.chat(k, entry.chatId) } : {}),
      })),
      explores: source.explores.map((round) => ({
        ...round,
        id: remap.explore(k, round.id),
        chatId: remap.chat(k, round.chatId),
        ...(round.attachments ? { attachments: attachments(round.attachments) } : {}),
      })),
      attachmentIndex,
    },
  }
}

const byKey = <T>(key: (item: T) => number) => (a: T, b: T) => key(a) - key(b)

/** Pure. `sources` are one project's legacy directories not yet listed in
 *  `existing?.session.migratedFrom`; `key` is `sessionKey(project)`. */
export function mergeLegacySessions(
  key: string,
  existing: ProjectFiles | null,
  sources: readonly LegacyFiles[],
): MergedSession {
  const order = [...sources]
    .sort((a, b) => a.session.createdAt - b.session.createdAt || a.key.localeCompare(b.key))
    .map(stampChats)
  const base = existing ? stampChats(existing) : null
  const remap = planIdRemap(base, order)
  const rewritten = order.map((source) => rewrite(source, remap))
  const all = [...(base ? [base] : []), ...rewritten.map((r) => r.files)]
  const project = order[0]?.session.project ?? existing!.session.project
  const folded = order.map((s) => legacyStamp(s.key, s.session.createdAt))

  const actives = rewritten.filter((r) => r.files.session.state === 'active')
  const newest = (actives[actives.length - 1] ?? rewritten[rewritten.length - 1])?.files.session
  const chats = all.flatMap((f) => f.session.chats ?? []).sort(byKey((c) => c.startedAt))
  const designHarness = [...rewritten]
    .reverse()
    .find((r) => r.files.session.designHarness !== undefined)?.files.session.designHarness

  let session: PersistedSession
  if (base) {
    session = { ...base.session, chats }
  } else {
    const active = actives.length > 0
    session = {
      project,
      app:
        active && newest
          ? { kind: 'attached', origin: newest.targetOrigin, attachedAt: newest.createdAt }
          : { kind: 'none' },
      ...(active ? { restoreOnStart: true as const } : {}),
      state: active ? 'active' : 'ended',
      ...(!active && newest?.endedBy ? { endedBy: newest.endedBy } : {}),
      createdAt: Math.min(...order.map((s) => s.session.createdAt)),
      ...(newest?.port !== undefined ? { port: newest.port } : {}),
      ...(active && newest?.agent ? { agent: newest.agent } : {}),
      ...(active && newest?.agentConfig ? { agentConfig: newest.agentConfig } : {}),
      chats,
      ...(newest?.currentChatId ? { currentChatId: newest.currentChatId } : {}),
      ...(designHarness !== undefined ? { designHarness } : {}),
    }
  }
  delete session.conversationClear
  session.migratedFrom = [...(existing?.session.migratedFrom ?? []), ...folded]

  return {
    folded,
    copies: rewritten.flatMap((r) => r.copies),
    files: {
      key,
      session,
      queue: all.flatMap((f) => f.queue).sort(byKey((a) => a.createdAt)),
      outbox: all.flatMap((f) => f.outbox).sort(byKey((b) => b.sentAt)),
      conversation: all.flatMap((f) => f.conversation).sort(byKey((e) => e.ts)),
      explores: all.flatMap((f) => f.explores).sort(byKey((e) => e.startedAt)),
      attachmentIndex: Object.assign({}, ...all.map((f) => f.attachmentIndex)),
    },
  }
}

export interface MigrationReport {
  /** Project -> legacy directories folded into it on this run. */
  merged: Map<string, string[]>
  /** Legacy directories left in place, and why. */
  skipped: { key: string; reason: 'no-project' | 'unreadable' }[]
}

const FILES = {
  queue: 'queue.json',
  outbox: 'outbox.json',
  conversation: 'conversation.json',
  explores: 'explores.json',
  attachmentIndex: 'attachments.json',
} as const

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function readFiles<S>(dir: string, key: string, session: S): SessionFiles<S> {
  return {
    key,
    session,
    queue: readJson<Annotation[]>(join(dir, FILES.queue)) ?? [],
    outbox: readJson<FeedbackBatch[]>(join(dir, FILES.outbox)) ?? [],
    conversation: readJson<ConversationEntry[]>(join(dir, FILES.conversation)) ?? [],
    explores: readJson<ExploreState[]>(join(dir, FILES.explores)) ?? [],
    attachmentIndex: readJson<Record<string, Attachment>>(join(dir, FILES.attachmentIndex)) ?? {},
  }
}

const TRANSIENT = /\.(staging|prev)-\d+$/

/** A crash mid-swap leaves `<key>.staging-<pid>` (never swapped in, so dropped)
 *  or `<key>.prev-<pid>` (the old `<key>`, renamed back when the swap never
 *  completed). */
function recover(sessionsDir: string, entries: string[]): void {
  for (const name of entries) {
    const path = join(sessionsDir, name)
    if (/\.staging-\d+$/.test(name)) rmSync(path, { recursive: true, force: true })
    const prev = /^(.*)\.prev-\d+$/.exec(name)
    if (!prev) continue
    const original = join(sessionsDir, prev[1]!)
    if (existsSync(original)) rmSync(path, { recursive: true, force: true })
    else renameSync(path, original)
  }
}

function writeMerged(
  sessionsDir: string,
  merged: MergedSession,
  hadExisting: boolean,
): void {
  const { key } = merged.files
  const target = join(sessionsDir, key)
  const staging = join(sessionsDir, `${key}.staging-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  const attachments = join(staging, 'attachments')
  mkdirSync(attachments, { recursive: true })
  if (hadExisting) {
    const own = join(target, 'attachments')
    for (const name of existsSync(own) ? readdirSync(own) : []) {
      copyFileSync(join(own, name), join(attachments, name))
    }
  }
  for (const copy of merged.copies) {
    const from = join(sessionsDir, copy.sourceKey, 'attachments', `${copy.from.id}-${copy.from.name}`)
    if (existsSync(from)) copyFileSync(from, join(attachments, `${copy.to.id}-${copy.to.name}`))
  }
  for (const [field, file] of Object.entries(FILES)) {
    writeFileSync(
      join(staging, file),
      JSON.stringify(merged.files[field as keyof typeof FILES], null, 2),
    )
  }
  writeFileSync(join(staging, 'session.json'), JSON.stringify(merged.files.session, null, 2))
  if (hadExisting) {
    const prev = join(sessionsDir, `${key}.prev-${process.pid}`)
    renameSync(target, prev)
    renameSync(staging, target)
    rmSync(prev, { recursive: true, force: true })
  } else {
    renameSync(staging, target)
  }
}

/** Never over an earlier backup of the same key: an older daemon run after the
 *  upgrade writes a new directory under it. */
function moveToLegacy(sessionsDir: string, legacyDir: string, key: string): void {
  mkdirSync(legacyDir, { recursive: true })
  let dest = join(legacyDir, key)
  for (let n = 2; existsSync(dest); n++) dest = join(legacyDir, `${key}-${n}`)
  renameSync(join(sessionsDir, key), dest)
}

/** The only function here that touches the disk. Safe on a data dir with
 *  nothing to do. */
export function migrateLegacySessions(
  sessionsDir: string = SESSIONS_DIR,
  legacyDir: string = LEGACY_SESSIONS_DIR,
): MigrationReport {
  const report: MigrationReport = { merged: new Map(), skipped: [] }
  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return report
  }
  recover(sessionsDir, entries)

  const legacy = new Map<string, LegacyFiles[]>()
  for (const key of readdirSync(sessionsDir)) {
    if (TRANSIENT.test(key)) continue
    const dir = join(sessionsDir, key)
    const session = readJson<Partial<LegacySession>>(join(dir, 'session.json'))
    if (typeof session?.targetOrigin !== 'string') {
      if (session === null && existsSync(join(dir, 'session.json'))) {
        report.skipped.push({ key, reason: 'unreadable' })
      }
      continue
    }
    if (typeof session.project !== 'string' || typeof session.createdAt !== 'number') {
      report.skipped.push({ key, reason: 'no-project' })
      continue
    }
    const files = readFiles(dir, key, session as LegacySession & { project: string })
    legacy.set(session.project, [...(legacy.get(session.project) ?? []), files])
  }

  for (const [project, sources] of legacy) {
    const key = sessionKey(project)
    const dir = join(sessionsDir, key)
    const own = readJson<PersistedSession>(join(dir, 'session.json'))
    const existing = own?.project === project && own.app ? readFiles(dir, key, own) : null
    if (!existing && existsSync(dir)) {
      report.skipped.push({ key, reason: 'unreadable' })
      continue
    }
    const listed = new Set(existing?.session.migratedFrom ?? [])
    const fresh = sources.filter((s) => !listed.has(legacyStamp(s.key, s.session.createdAt)))
    if (fresh.length) {
      const merged = mergeLegacySessions(key, existing, fresh)
      writeMerged(sessionsDir, merged, existing !== null)
      report.merged.set(project, merged.folded)
    }
    for (const source of sources) moveToLegacy(sessionsDir, legacyDir, source.key)
  }
  return report
}
