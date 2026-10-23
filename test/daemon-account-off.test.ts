import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DaemonWorld } from './helpers/daemon.js'

const world = await DaemonWorld.create()
let origin = ''

before(async () => {
  world.spawnDaemon()
  const { port } = await world.liveDaemon()
  const { shellUrl } = await world.openSession(port, { project: mkdtempSync(join(world.dataDir, 'project-')) })
  origin = new URL(shellUrl).origin
})

after(() => world.dispose())

test('without EZDESIGN_ACCOUNT the shell is told nothing about an account and offers no sign-in', async () => {
  const state = (await (await fetch(`${origin}/__ezdesign/api/state`)).json()) as Record<string, unknown>
  assert.equal('account' in state, false)
  assert.equal((await fetch(`${origin}/__ezdesign/api/account/login`, { redirect: 'manual' })).status, 404)
  assert.equal((await fetch(`${origin}/__ezdesign/account/callback?code=c&state=s`)).status, 404)
})
