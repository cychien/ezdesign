import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { recordExtensionSeen } from '../src/capture-seen.js'
import { EXTENSION_ID } from '../src/capture-wire.js'
import { MacAppInstaller } from '../src/mac-app.js'
import type { SetupWire } from '../src/setup-wire.js'
import { SetupWatch } from '../src/setup-watch.js'

const CHROME_DEFAULT = 'Library/Application Support/Google/Chrome/Default'

function world() {
  const root = mkdtempSync(join(tmpdir(), 'ezdesign-setup-watch-'))
  const home = join(root, 'home')
  const dataDir = join(root, 'data')
  const macApp = new MacAppInstaller({
    platform: 'darwin',
    dirs: [join(root, 'Applications')],
    feed: 'http://127.0.0.1:9',
    arch: async () => 'arm64',
    open: async () => {},
  })
  const sent: SetupWire[] = []
  const watch = new SetupWatch({ home, platform: 'darwin', dataDir, macApp, onChange: (s) => sent.push(s), pollMs: 20 })
  const chrome = (settings: Record<string, unknown>) => {
    mkdirSync(join(home, CHROME_DEFAULT), { recursive: true })
    writeFileSync(join(home, CHROME_DEFAULT, 'Secure Preferences'), JSON.stringify({ extensions: { settings } }))
  }
  return { home, dataDir, macApp, watch, sent, chrome }
}

async function until(check: () => boolean, what: string): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 3000) assert.fail(`never: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('a held watch tells of an install and a removal as they land, and nothing in between', async () => {
  const { dataDir, watch, sent, chrome } = world()
  const release = watch.hold()
  await until(() => sent.length === 1, 'the first read')
  assert.deepEqual(sent[0]!.extension, { installed: false, installedIn: [] })

  recordExtensionSeen(dataDir, '0.12.0')
  await until(() => sent.length === 2, 'the greeting')
  assert.deepEqual(sent[1]!.extension, { installed: true, installedIn: [] }, 'loaded, not yet written down')

  chrome({ [EXTENSION_ID]: { path: '/x', disable_reasons: [] } })
  await until(() => sent.length === 3, 'the record')
  assert.deepEqual(sent[2]!.extension, { installed: true, installedIn: ['Google Chrome'] })

  await new Promise((r) => setTimeout(r, 100))
  assert.equal(sent.length, 3, 'unchanged files are not read again, and an unchanged state is not sent')

  chrome({ [EXTENSION_ID]: {} })
  await until(() => sent.length === 4, 'the removal')
  assert.deepEqual(sent[3]!.extension, { installed: false, installedIn: [] })

  release()
  // A read already under way when the last shell leaves still finishes; only new ones stop.
  await watch.settled()
  chrome({ [EXTENSION_ID]: { path: '/x', disable_reasons: [] } })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(sent.length, 4, 'with no shell holding it, nothing is watched')
})

test('the watch is held once per shell and stops with the last', async () => {
  const { watch, sent, chrome } = world()
  const first = watch.hold()
  const second = watch.hold()
  await until(() => sent.length === 1, 'the first read')
  first()
  first()
  chrome({ [EXTENSION_ID]: { path: '/x', disable_reasons: [] } })
  await until(() => sent.length === 2, 'still watched for the second shell')
  second()
  await watch.settled()
  chrome({ [EXTENSION_ID]: {} })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(sent.length, 2)
  assert.equal(watch.setup?.extension.installed, true, 'the last state is kept for the next shell to start from')
})

test('an install’s steps reach the shells without waiting for the poll', async () => {
  const { macApp, sent } = world()
  const root = mkdtempSync(join(tmpdir(), 'ezdesign-setup-watch-'))
  const slow = new SetupWatch({
    home: join(root, 'home'),
    platform: 'darwin',
    dataDir: join(root, 'data'),
    macApp,
    onChange: (s) => sent.push(s),
    pollMs: 60_000,
  })
  const release = slow.hold()
  await until(() => sent.length === 1, 'the first read')
  macApp.start()
  await macApp.settled()
  await until(() => sent.at(-1)?.macApp.job.phase === 'failed', 'the failure, long before the next poll')
  release()
})
