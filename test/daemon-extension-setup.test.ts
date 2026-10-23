import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { recordExtensionSeen } from '../src/capture-seen.js'
import type { ExtensionInstallErrorWire, ExtensionStatusWire } from '../src/capture-setup-wire.js'
import { DaemonWorld } from './helpers/daemon.js'

const world = await DaemonWorld.create()
const home = join(world.dataDir, 'real-home', '.ezdesign')
let api = ''

before(async () => {
  world.env.EZDESIGN_LIBRARY_HOME = home
  world.spawnDaemon()
  const { port } = await world.liveDaemon()
  const { shellUrl } = await world.openSession(port, { project: mkdtempSync(join(world.dataDir, 'project-')) })
  api = `${new URL(shellUrl).origin}/__ezdesign/api`
})

after(() => world.dispose())

test('the shell learns when the capture host last greeted the extension', async () => {
  const status = async () => (await (await fetch(`${api}/extension/status`)).json()) as ExtensionStatusWire
  assert.deepEqual(await status(), { greeted: null })
  const before = Date.now()
  recordExtensionSeen(home, '1.2.3')
  const { greeted } = await status()
  assert.equal(greeted?.version, '1.2.3')
  assert.ok(greeted.at >= before, `greeted at ${greeted.at}, before ${before}`)
})

test('installing from the shell names what went wrong, and no other site can ask', async () => {
  const install = async (headers: Record<string, string> = {}) => {
    const res = await fetch(`${api}/extension/install`, { method: 'POST', headers })
    return { status: res.status, body: (await res.json()) as Partial<ExtensionInstallErrorWire> }
  }
  const none = await install()
  assert.deepEqual([none.status, none.body.problem], [422, 'no-browser'])
  assert.match(none.body.error ?? '', /no Chromium browser/)

  // A browser to install for; the daemon here runs from source, which has no host bundle.
  const profile = process.platform === 'darwin' ? 'Library/Application Support/Google/Chrome' : '.config/google-chrome'
  mkdirSync(join(world.dataDir, profile), { recursive: true })
  const unbuilt = await install()
  assert.deepEqual([unbuilt.status, unbuilt.body.problem], [422, 'not-built'])

  assert.equal((await install({ origin: 'https://evil.test' })).status, 403)
})
