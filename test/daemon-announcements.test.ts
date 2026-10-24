import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AnnouncementsSeenWire } from '../src/announcement-wire.js'
import { DaemonWorld } from './helpers/daemon.js'

const world = await DaemonWorld.create()
let control = 0
let api = ''

const openApi = async () => {
  const { shellUrl } = await world.openSession(control, { project: mkdtempSync(join(world.dataDir, 'project-')) })
  return `${new URL(shellUrl).origin}/__ezdesign/api`
}

before(async () => {
  world.spawnDaemon()
  control = (await world.liveDaemon()).port
  api = await openApi()
})

after(() => world.dispose())

const seen = async (base = api) => ((await (await fetch(`${base}/announcements/seen`)).json()) as AnnouncementsSeenWire).seen
const markSeen = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${api}/announcements/seen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

test('a dismissed announcement stays dismissed in every session', async () => {
  assert.deepEqual(await seen(), [])
  assert.deepEqual(((await (await markSeen({ id: 'canvas' })).json()) as AnnouncementsSeenWire).seen, ['canvas'])
  await markSeen({ id: 'canvas' })
  assert.deepEqual(await seen(), ['canvas'])
  assert.deepEqual(await seen(await openApi()), ['canvas'])
})

test('only the shell can mark one seen, and only by id', async () => {
  assert.equal((await markSeen({})).status, 400)
  assert.equal((await markSeen({ id: 'x' }, { origin: 'https://evil.test' })).status, 403)
})
