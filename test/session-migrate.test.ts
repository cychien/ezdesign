import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrateLegacySessions } from '../src/session-migrate.js'
import { SessionDirectory } from '../src/session-directory.js'

const P = '/work/project-p'
const Q = '/work/project-q'
const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const projectKey = sha
const legacyKey = (origin: string, project: string) => sha(`${origin}\n${project}`)

function dirs(): { sessions: string; legacy: string } {
  const root = mkdtempSync(join(tmpdir(), 'ezdesign-migrate-'))
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  return { sessions, legacy: join(root, 'sessions-legacy') }
}

function writeDir(root: string, key: string, files: Record<string, unknown>): void {
  const dir = join(root, key)
  mkdirSync(join(dir, 'attachments'), { recursive: true })
  for (const [name, value] of Object.entries(files)) {
    if (name.startsWith('attachments/')) writeFileSync(join(dir, name), value as string)
    else writeFileSync(join(dir, name), JSON.stringify(value, null, 2))
  }
}

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`)
      else out[`${prefix}${name}`] = `${statSync(path).mtimeMs} ${sha(readFileSync(path, 'latin1'))}`
    }
  }
  walk(root, '')
  return out
}

const annotation = (id: string, comment: string, createdAt: number, attachments?: unknown[]) => ({
  id,
  kind: 'element',
  comment,
  anchor: { selector: 'h1' },
  createdAt,
  ...(attachments ? { attachments } : {}),
})

/** The plan's seed: P on 5173 and on 5174 (sharing one annotation id), Q on 5173. */
function seedThree(sessions: string) {
  const p5173 = legacyKey('http://localhost:5173', P)
  const p5174 = legacyKey('http://localhost:5174', P)
  const q5173 = legacyKey('http://localhost:5173', Q)
  const shot = { id: 'att000000001', name: 'shot.png', mime: 'image/png', size: 5, createdAt: 1_000 }
  writeDir(sessions, p5173, {
    'session.json': {
      targetOrigin: 'http://localhost:5173',
      project: P,
      state: 'ended',
      endedBy: 'agent',
      createdAt: 1_000,
      port: 50111,
      chats: [
        { id: 'chat0000000a', startedAt: 1_000 },
        { id: 'chat0000000b', startedAt: 1_500 },
      ],
      currentChatId: 'chat0000000b',
    },
    'queue.json': [annotation('ann000000001', 'p1 first', 1_100, [shot]), annotation('ann000000002', 'p1 second', 1_200)],
    'outbox.json': [{ batchId: 'batch0000001', items: [], note: 'undelivered', sentAt: 1_300 }],
    'conversation.json': [
      { role: 'user', text: 'one', ts: 1_010, chatId: 'chat0000000a' },
      { role: 'agent', text: 'two', ts: 1_020, chatId: 'chat0000000a' },
      { role: 'user', text: 'three', ts: 1_510, chatId: 'chat0000000b' },
      { role: 'agent', text: 'four', ts: 1_520, chatId: 'chat0000000b' },
    ],
    'attachments.json': { [shot.id]: shot },
    [`attachments/${shot.id}-shot.png`]: 'bytes',
  })
  writeDir(sessions, p5174, {
    'session.json': {
      targetOrigin: 'http://localhost:5174',
      project: P,
      state: 'active',
      createdAt: 2_000,
      port: 50123,
      chats: [{ id: 'chat0000000c', startedAt: 2_000 }],
      currentChatId: 'chat0000000c',
    },
    'queue.json': [annotation('ann000000001', 'p2 colliding', 2_100)],
    'conversation.json': [
      { role: 'user', text: 'five', ts: 2_010, chatId: 'chat0000000c' },
      { role: 'agent', text: 'six', ts: 2_020, chatId: 'chat0000000c' },
    ],
  })
  writeDir(sessions, q5173, {
    'session.json': { targetOrigin: 'http://localhost:5173', project: Q, state: 'active', createdAt: 500 },
    'queue.json': [annotation('annq00000001', 'q only', 600)],
  })
  return { p5173, p5174, q5173 }
}

test('CV-session-migrate: legacy dirs fold into project sessions and lose nothing', () => {
  const { sessions, legacy } = dirs()
  const keys = seedThree(sessions)
  const before = Object.fromEntries(
    Object.values(keys).map((k) => [k, snapshotTree(join(sessions, k))]),
  )

  const report = migrateLegacySessions(sessions, legacy)

  assert.deepEqual(readdirSync(sessions).sort(), [projectKey(P), projectKey(Q)].sort())
  assert.deepEqual(readdirSync(legacy).sort(), Object.values(keys).sort())
  for (const [key, tree] of Object.entries(before)) {
    const after = snapshotTree(join(legacy, key))
    assert.deepEqual(
      Object.fromEntries(Object.entries(after).map(([f, v]) => [f, v.split(' ')[1]])),
      Object.fromEntries(Object.entries(tree).map(([f, v]) => [f, v.split(' ')[1]])),
    )
  }
  assert.deepEqual([...report.merged.keys()].sort(), [P, Q].sort())

  const pDir = join(sessions, projectKey(P))
  const queue = read<{ id: string; comment: string }[]>(join(pDir, 'queue.json'))
  assert.equal(queue.length, 3)
  assert.equal(new Set(queue.map((a) => a.id)).size, 3)
  assert.deepEqual(queue.map((a) => a.comment), ['p1 first', 'p1 second', 'p2 colliding'])
  assert.equal(queue[2]!.id, sha(`${keys.p5174}\nann000000001`))

  const conversation = read<{ text: string; chatId: string }[]>(join(pDir, 'conversation.json'))
  assert.deepEqual(conversation.map((e) => e.text), ['one', 'two', 'three', 'four', 'five', 'six'])
  assert.equal(new Set(conversation.map((e) => e.chatId)).size, 3)

  const session = read<Record<string, unknown>>(join(pDir, 'session.json'))
  assert.deepEqual(session.app, { kind: 'attached', origin: 'http://localhost:5174', attachedAt: 2_000 })
  assert.equal(session.port, 50123)
  assert.equal(session.state, 'active')
  assert.equal(session.restoreOnStart, true)
  assert.equal(session.createdAt, 1_000)
  assert.equal(session.currentChatId, 'chat0000000c')
  assert.equal((session.chats as unknown[]).length, 3)
  assert.equal('targetOrigin' in session, false)
  assert.deepEqual(session.migratedFrom, [`${keys.p5173}@1000`, `${keys.p5174}@2000`])

  const outbox = read<{ batchId: string; note: string }[]>(join(pDir, 'outbox.json'))
  assert.deepEqual(outbox.map((b) => b.batchId), ['batch0000001'])
  assert.equal(readFileSync(join(pDir, 'attachments', 'att000000001-shot.png'), 'utf8'), 'bytes')
  assert.equal(read<Record<string, unknown>>(join(pDir, 'attachments.json'))['att000000001'] !== undefined, true)

  const qQueue = read<{ comment: string }[]>(join(sessions, projectKey(Q), 'queue.json'))
  assert.deepEqual(qQueue.map((a) => a.comment), ['q only'])

  const settled = snapshotTree(sessions)
  const again = migrateLegacySessions(sessions, legacy)
  assert.equal(again.merged.size, 0)
  assert.deepEqual(snapshotTree(sessions), settled)
})

test('a colliding batch, chat and attachment id is rewritten everywhere it is referenced', () => {
  const { sessions, legacy } = dirs()
  const shared = { id: 'sharedatt001', name: 'a.png', mime: 'image/png', size: 1, createdAt: 1 }
  for (const [origin, createdAt, text] of [
    ['http://localhost:5173', 1_000, 'old'],
    ['http://localhost:5174', 2_000, 'new'],
  ] as const) {
    writeDir(sessions, legacyKey(origin, P), {
      'session.json': {
        targetOrigin: origin,
        project: P,
        state: 'active',
        createdAt,
        chats: [
          { id: 'mainchat0001', startedAt: createdAt },
          { id: 'branch000001', startedAt: createdAt + 5, parentChatId: 'mainchat0001' },
        ],
        currentChatId: 'branch000001',
      },
      'outbox.json': [
        {
          batchId: 'samebatch001',
          items: [annotation('sameitem0001', text, createdAt, [shared])],
          note: text,
          sentAt: createdAt,
        },
      ],
      'conversation.json': [{ role: 'user', text, ts: createdAt + 6, batchId: 'samebatch001', chatId: 'branch000001' }],
      'explores.json': [
        { id: 'explore00001', chatId: 'branch000001', label: text, anchor: {}, status: 'done', variants: [], selected: null, startedAt: createdAt },
      ],
      'attachments.json': { [shared.id]: shared },
      [`attachments/${shared.id}-a.png`]: text,
    })
  }
  migrateLegacySessions(sessions, legacy)
  const dir = join(sessions, projectKey(P))
  const newKey = legacyKey('http://localhost:5174', P)
  const remapped = (id: string) => sha(`${newKey}\n${id}`)

  const outbox = read<{ batchId: string; items: { id: string; attachments: { id: string }[] }[] }[]>(join(dir, 'outbox.json'))
  assert.deepEqual(outbox.map((b) => b.batchId), ['samebatch001', remapped('samebatch001')])
  assert.equal(outbox[1]!.items[0]!.id, remapped('sameitem0001'))
  assert.equal(outbox[1]!.items[0]!.attachments[0]!.id, remapped('sharedatt001'))

  const conversation = read<{ text: string; batchId: string; chatId: string }[]>(join(dir, 'conversation.json'))
  assert.deepEqual(
    conversation.map((e) => [e.text, e.batchId, e.chatId]),
    [
      ['old', 'samebatch001', 'branch000001'],
      ['new', remapped('samebatch001'), remapped('branch000001')],
    ],
  )
  const session = read<{ chats: { id: string; parentChatId?: string }[]; currentChatId: string }>(join(dir, 'session.json'))
  assert.deepEqual(
    session.chats.map((c) => [c.id, c.parentChatId]),
    [
      ['mainchat0001', undefined],
      ['branch000001', 'mainchat0001'],
      [remapped('mainchat0001'), undefined],
      [remapped('branch000001'), remapped('mainchat0001')],
    ],
  )
  assert.equal(session.currentChatId, remapped('branch000001'))
  const explores = read<{ id: string; chatId: string }[]>(join(dir, 'explores.json'))
  assert.deepEqual(explores.map((e) => [e.id, e.chatId]), [
    ['explore00001', 'branch000001'],
    [remapped('explore00001'), remapped('branch000001')],
  ])
  assert.equal(readFileSync(join(dir, 'attachments', 'sharedatt001-a.png'), 'utf8'), 'old')
  assert.equal(readFileSync(join(dir, 'attachments', `${remapped('sharedatt001')}-a.png`), 'utf8'), 'new')
})

test('a record from before chats keeps hidden history hidden once merged', () => {
  const { sessions, legacy } = dirs()
  writeDir(sessions, legacyKey('http://localhost:5173', P), {
    'session.json': { targetOrigin: 'http://localhost:5173', project: P, state: 'active', createdAt: 1_000, conversationClear: { at: 1_500 } },
    'conversation.json': [
      { role: 'user', text: 'cleared', ts: 1_100 },
      { role: 'user', text: 'kept', ts: 1_600 },
    ],
  })
  migrateLegacySessions(sessions, legacy)
  const dir = join(sessions, projectKey(P))
  const session = read<{ chats: { id: string; startedAt: number }[]; conversationClear?: unknown }>(join(dir, 'session.json'))
  assert.equal(session.chats.length, 1)
  assert.equal(session.chats[0]!.startedAt, 1_500)
  assert.equal(session.conversationClear, undefined)
  const conversation = read<{ text: string; chatId: string }[]>(join(dir, 'conversation.json'))
  assert.equal(conversation.find((e) => e.text === 'kept')!.chatId, session.chats[0]!.id)
  assert.notEqual(conversation.find((e) => e.text === 'cleared')!.chatId, session.chats[0]!.id)
})

test('a record without a project stays where it is', () => {
  const { sessions, legacy } = dirs()
  writeDir(sessions, 'noproject001', {
    'session.json': { targetOrigin: 'http://localhost:5173', state: 'active', createdAt: 1 },
  })
  const report = migrateLegacySessions(sessions, legacy)
  assert.deepEqual(report.skipped, [{ key: 'noproject001', reason: 'no-project' }])
  assert.deepEqual(readdirSync(sessions), ['noproject001'])
  assert.equal(existsSync(legacy), false)
})

test('an existing project session keeps its own fields and gains the legacy records', () => {
  const { sessions, legacy } = dirs()
  writeDir(sessions, projectKey(P), {
    'session.json': {
      project: P,
      app: { kind: 'attached', origin: 'http://localhost:6000', attachedAt: 9_000 },
      state: 'active',
      createdAt: 9_000,
      port: 51234,
      chats: [{ id: 'nowchat00001', startedAt: 9_000 }],
      currentChatId: 'nowchat00001',
    },
    'queue.json': [annotation('ann000000001', 'now', 9_100)],
  })
  const key = legacyKey('http://localhost:5173', P)
  writeDir(sessions, key, {
    'session.json': { targetOrigin: 'http://localhost:5173', project: P, state: 'active', createdAt: 1_000, port: 50000 },
    'queue.json': [annotation('ann000000001', 'then', 1_100)],
  })
  migrateLegacySessions(sessions, legacy)
  const dir = join(sessions, projectKey(P))
  const session = read<Record<string, unknown>>(join(dir, 'session.json'))
  assert.deepEqual(session.app, { kind: 'attached', origin: 'http://localhost:6000', attachedAt: 9_000 })
  assert.equal(session.port, 51234)
  assert.equal(session.currentChatId, 'nowchat00001')
  assert.deepEqual(session.migratedFrom, [`${key}@1000`])
  const queue = read<{ id: string; comment: string }[]>(join(dir, 'queue.json'))
  assert.deepEqual(queue.map((a) => [a.id, a.comment]), [
    [sha(`${key}\nann000000001`), 'then'],
    ['ann000000001', 'now'],
  ])
})

test('a legacy dir an older daemon wrote again under a folded key is folded in too', () => {
  const { sessions, legacy } = dirs()
  const key = legacyKey('http://localhost:5173', P)
  const legacyRecord = (createdAt: number, comment: string) => ({
    'session.json': { targetOrigin: 'http://localhost:5173', project: P, state: 'active', createdAt },
    'queue.json': [annotation(`a${createdAt}`, comment, createdAt)],
  })
  writeDir(sessions, key, legacyRecord(1_000, 'before the upgrade'))
  migrateLegacySessions(sessions, legacy)
  writeDir(sessions, key, legacyRecord(5_000, 'during a downgrade'))
  migrateLegacySessions(sessions, legacy)
  const queue = read<{ comment: string }[]>(join(sessions, projectKey(P), 'queue.json'))
  assert.deepEqual(queue.map((a) => a.comment), ['before the upgrade', 'during a downgrade'])
  assert.deepEqual(readdirSync(legacy).sort(), [key, `${key}-2`])
})

test('a swap a crash interrupted is rolled back before migrating again', () => {
  const { sessions, legacy } = dirs()
  seedThree(sessions)
  migrateLegacySessions(sessions, legacy)
  const pDir = join(sessions, projectKey(P))
  const settled = readFileSync(join(pDir, 'queue.json'), 'utf8')
  renameSync(pDir, `${pDir}.prev-4242`)
  mkdirSync(`${pDir}.staging-4242`)
  writeFileSync(join(`${pDir}.staging-4242`, 'queue.json'), '[]')
  migrateLegacySessions(sessions, legacy)
  assert.deepEqual(readdirSync(sessions).sort(), [projectKey(P), projectKey(Q)].sort())
  assert.equal(readFileSync(join(pDir, 'queue.json'), 'utf8'), settled)
})

test('CV-migrate-live-predecessor: restore migrates only once the predecessor is gone', async () => {
  for (const predecessorGone of [false, true]) {
    const { sessions, legacy } = dirs()
    const key = legacyKey('http://localhost:5173', P)
    writeDir(sessions, key, {
      'session.json': { targetOrigin: 'http://localhost:5173', project: P, state: 'active', createdAt: 1 },
      'queue.json': [annotation('a1', 'mid-write', 1)],
    })
    const before = readFileSync(join(sessions, key, 'queue.json'))
    const directory = new SessionDirectory(
      () => {
        throw new Error('no runtime expected')
      },
      { restorable: () => [], get: () => null, migrate: () => void migrateLegacySessions(sessions, legacy) },
    )
    await directory.restore({ migrate: predecessorGone })
    if (predecessorGone) {
      assert.equal(existsSync(join(legacy, key)), true)
      assert.equal(existsSync(join(sessions, projectKey(P))), true)
    } else {
      assert.deepEqual(readFileSync(join(sessions, key, 'queue.json')), before)
      assert.equal(existsSync(legacy), false)
    }
  }
})
