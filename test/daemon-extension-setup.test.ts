import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { recordExtensionSeen } from '../src/capture-seen.js'
import type { ExtensionInstallErrorWire, ExtensionStatusWire } from '../src/capture-setup-wire.js'
import { EXTENSION_ID } from '../src/capture-wire.js'
import type { MacAppWire } from '../src/mac-app-wire.js'
import type { SetupEventWire } from '../src/setup-wire.js'
import { DaemonWorld } from './helpers/daemon.js'

const world = await DaemonWorld.create()
const home = join(world.dataDir, 'real-home', '.ezdesign')
const applications = join(world.dataDir, 'Applications')
let api = ''

before(async () => {
  world.env.EZDESIGN_LIBRARY_HOME = home
  world.env.EZDESIGN_APPLICATIONS_DIR = applications
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

/** A shell's event stream, read event by event. */
async function shellStream(): Promise<{ next(type: string): Promise<unknown>; close(): void }> {
  const controller = new AbortController()
  const res = await fetch(`${api}/events?shell=1`, { signal: controller.signal })
  const reader = res.body!.getReader()
  let text = ''
  return {
    async next(type) {
      for (;;) {
        const match = new RegExp(`event: ${type}\ndata: (.*)\n\n`).exec(text)
        if (match) {
          text = text.slice(match.index + match[0].length)
          return JSON.parse(match[1]!)
        }
        text += new TextDecoder().decode((await reader.read()).value)
      }
    },
    close: () => controller.abort(),
  }
}

test('every shell is told when the extension is installed and removed, without asking', async () => {
  const chrome = process.platform === 'darwin' ? 'Library/Application Support/Google/Chrome' : '.config/google-chrome'
  const record = (settings: unknown) => {
    mkdirSync(join(world.dataDir, chrome, 'Default'), { recursive: true })
    writeFileSync(join(world.dataDir, chrome, 'Default', 'Secure Preferences'), JSON.stringify({ extensions: { settings } }))
  }
  record({})
  const stream = await shellStream()
  try {
    const first = (await stream.next('setup')) as SetupEventWire
    assert.deepEqual(first.setup.extension, { installed: false, installedIn: [] }, 'an old greeting is not an install')
    assert.equal(first.setup.macApp.supported, process.platform === 'darwin')

    record({ [EXTENSION_ID]: { path: '/x', disable_reasons: [] } })
    assert.deepEqual(((await stream.next('setup')) as SetupEventWire).setup.extension, {
      installed: true,
      installedIn: ['Google Chrome'],
    })
    record({ [EXTENSION_ID]: {} })
    assert.deepEqual(((await stream.next('setup')) as SetupEventWire).setup.extension, { installed: false, installedIn: [] })
  } finally {
    stream.close()
    rmSync(join(world.dataDir, chrome), { recursive: true })
  }
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

test('the shell learns whether the Mac app is installed, and no other site can install or open it', async () => {
  const res = await fetch(`${api}/mac-app`)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const status = (await res.json()) as MacAppWire
  assert.equal(status.supported, process.platform === 'darwin')
  assert.equal(status.installed, null)
  assert.deepEqual(status.job, { phase: 'idle' })

  assert.equal((await fetch(`${api}/mac-app/open`, { method: 'POST' })).status, 404)
  const evil = { method: 'POST', headers: { origin: 'https://evil.test' } }
  assert.equal((await fetch(`${api}/mac-app/install`, evil)).status, 403)
  assert.equal((await fetch(`${api}/mac-app/open`, evil)).status, 403)
})
