import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type ProjectRuntime, SessionDirectory } from '../src/session-directory.js'
import type { AppAttachment, AttachedApp, PersistedSession } from '../src/store.js'

class FakeRuntime implements ProjectRuntime {
  app: AppAttachment = { kind: 'none' }
  port = 0
  state: 'active' | 'ended' = 'active'
  endedByUser = false
  restoreOnStart = false
  resumed = 0
  readonly log: string[] = []

  constructor(readonly project: string) {}

  async start(): Promise<number> {
    await new Promise((r) => setTimeout(r, 5))
    this.port = 50_000 + this.project.length
    return this.port
  }
  attachApp(app: AttachedApp, opts: { userAttached: boolean }): void {
    this.app = app
    this.log.push(`attach ${app.origin} ${opts.userAttached ? 'user' : 'record'}`)
  }
  detachApp(): void {
    this.app = { kind: 'none' }
    this.log.push('detach')
  }
  reopen(): void {
    this.state = 'active'
    this.endedByUser = false
    this.log.push('reopen')
  }
  setRestoreOnStart(on: boolean): void {
    this.restoreOnStart = on
  }
  resumeAgent(): void {
    this.resumed++
  }
}

const record = (project: string, app: AppAttachment, state: 'active' | 'ended' = 'active'): PersistedSession => ({
  project,
  app,
  state,
  createdAt: 1,
  restoreOnStart: true,
})

function directory(records: PersistedSession[] = []) {
  const made: FakeRuntime[] = []
  const dir = new SessionDirectory(
    (project) => {
      const runtime = new FakeRuntime(project)
      made.push(runtime)
      return runtime
    },
    {
      restorable: () => records.filter((r) => r.state === 'active'),
      get: (project) => records.find((r) => r.project === project) ?? null,
      migrate: () => {},
    },
  )
  return { dir, made }
}

test('concurrent opens of one project yield one runtime', async () => {
  const { dir, made } = directory()
  const opened = await Promise.all(
    Array.from({ length: 30 }, () => dir.open({ project: '/p', reopen: false, now: 1 })),
  )
  assert.equal(made.length, 1)
  assert.ok(opened.every((o) => o.ok && o.runtime === made[0]))
  assert.equal(made[0]!.restoreOnStart, true)
})

test('attaching an origin another project holds moves it and leaves that session running', async () => {
  const { dir } = directory()
  const p = await dir.open({ project: '/p', origin: 'http://localhost:5173', reopen: false, now: 1 })
  const q = await dir.open({ project: '/q', origin: 'http://localhost:5173', reopen: false, now: 2 })
  assert.ok(p.ok && q.ok)
  assert.deepEqual(p.runtime.app, { kind: 'none' })
  assert.deepEqual(q.runtime.app, { kind: 'attached', origin: 'http://localhost:5173', attachedAt: 2 })
  assert.equal(dir.byOrigin('http://localhost:5173'), q.runtime)
  assert.equal(dir.size, 2)
})

test('an open with no origin keeps the app already attached', async () => {
  const { dir } = directory()
  await dir.open({ project: '/p', origin: 'http://localhost:5173', reopen: false, now: 1 })
  const again = await dir.open({ project: '/p', reopen: false, now: 2 })
  assert.ok(again.ok)
  assert.deepEqual(again.runtime.app, { kind: 'attached', origin: 'http://localhost:5173', attachedAt: 1 })
})

test('a session the user ended is refused without --reopen, and the refusal moves no origin', async () => {
  const { dir } = directory()
  const holder = await dir.open({ project: '/holder', origin: 'http://localhost:5173', reopen: false, now: 1 })
  const ended = await dir.open({ project: '/ended', reopen: false, now: 1 })
  assert.ok(holder.ok && ended.ok)
  const runtime = ended.runtime as FakeRuntime
  runtime.state = 'ended'
  runtime.endedByUser = true

  const refused = await dir.open({ project: '/ended', origin: 'http://localhost:5173', reopen: false, now: 2 })
  assert.deepEqual(refused, { ok: false, reason: 'ended-by-user' })
  assert.equal(holder.runtime.app.kind, 'attached')

  const reopened = await dir.open({ project: '/ended', origin: 'http://localhost:5173', reopen: true, now: 3 })
  assert.ok(reopened.ok)
  assert.deepEqual(runtime.log, ['reopen', 'attach http://localhost:5173 user'])
})

test('restore hands a contested origin to the newest attach and resumes every agent', async () => {
  const origin = 'http://localhost:5173'
  const { dir, made } = directory([
    record('/newer', { kind: 'attached', origin, attachedAt: 20 }),
    record('/older', { kind: 'attached', origin, attachedAt: 10 }),
    record('/plain', { kind: 'none' }),
  ])
  await dir.restore({ migrate: true })
  const by = Object.fromEntries(made.map((r) => [r.project, r]))
  assert.deepEqual(by['/newer']!.log, [`attach ${origin} record`])
  assert.deepEqual(by['/older']!.log, ['detach'])
  assert.deepEqual(by['/plain']!.log, [])
  assert.deepEqual(made.map((r) => r.resumed), [1, 1, 1])
})

test('find wakes a persisted active session and nothing else', async () => {
  const { dir, made } = directory([
    record('/sleeping', { kind: 'none' }),
    record('/over', { kind: 'none' }, 'ended'),
  ])
  assert.equal((await dir.find('/sleeping'))?.project, '/sleeping')
  assert.equal(made[0]!.resumed, 0)
  assert.equal(await dir.find('/over'), null)
  assert.equal(await dir.find('/unknown'), null)
  assert.equal(dir.size, 1)
})

test('the idle exit clears restoreOnStart on every live session', async () => {
  const { dir, made } = directory()
  await dir.open({ project: '/a', reopen: false, now: 1 })
  await dir.open({ project: '/b', reopen: false, now: 1 })
  dir.retireIdle()
  assert.deepEqual(made.map((r) => r.restoreOnStart), [false, false])
})
