import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { extensionRecordFiles, readExtensionPresence } from '../src/capture-install/index.js'
import { EXTENSION_ID } from '../src/capture-wire.js'

const MAC = 'Library/Application Support'

function record(home: string, browserDir: string, profile: string, file: string, settings: Record<string, unknown>, at?: number): string {
  const dir = join(home, browserDir, profile)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, file)
  writeFileSync(path, JSON.stringify({ extensions: { settings } }))
  if (at !== undefined) utimesSync(path, at / 1000, at / 1000)
  return path
}

/** As Chrome writes a loaded extension: where it was loaded from, and no reason it is off. */
const ours = (extra: Record<string, unknown> = {}) => ({
  [EXTENSION_ID]: { path: '/Users/me/.ezdesign/extension', location: 4, disable_reasons: [], ...extra },
})

async function presence(home: string, greeted: { version: string; at: number } | null = null) {
  return readExtensionPresence({ files: await extensionRecordFiles({ home, platform: 'darwin' }), greeted })
}

test('installed where a profile lists it, enabled; a removed one’s leftover stub and a disabled one are not', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ezdesign-presence-'))
  assert.deepEqual(await presence(home), { installed: false, installedIn: [] }, 'no browsers at all')

  record(home, `${MAC}/Google/Chrome`, 'Default', 'Secure Preferences', { [EXTENSION_ID]: {} })
  assert.deepEqual(await presence(home), { installed: false, installedIn: [] }, 'what Chrome leaves under the id after a removal')

  record(home, `${MAC}/Google/Chrome`, 'Profile 2', 'Secure Preferences', ours())
  record(home, `${MAC}/Arc/User Data`, 'Default', 'Preferences', ours())
  record(home, `${MAC}/BraveSoftware/Brave-Browser`, 'Default', 'Secure Preferences', ours({ disable_reasons: [1] }))
  record(home, `${MAC}/Microsoft Edge`, 'Default', 'Secure Preferences', ours({ disable_reasons: 1 }))
  record(home, `${MAC}/Vivaldi`, 'Default', 'Secure Preferences', ours({ disable_reasons: undefined, state: 0 }))
  record(home, `${MAC}/Chromium`, 'System Profile', 'Secure Preferences', ours())
  assert.deepEqual(await presence(home), { installed: true, installedIn: ['Google Chrome', 'Arc'] })

  writeFileSync(join(home, `${MAC}/Arc/User Data/Default/Preferences`), '{"extensions": {"settings": {')
  assert.deepEqual((await presence(home)).installedIn, ['Google Chrome'], 'a file caught mid-write reads as not there')
  assert.deepEqual(await extensionRecordFiles({ home, platform: 'win32' }), [])
})

test('a greeting stands in for an install the browser has not written down yet, and no longer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ezdesign-presence-'))
  const t = Date.now() - 60_000
  record(home, `${MAC}/Google/Chrome`, 'Default', 'Secure Preferences', {}, t)
  const plain = record(home, `${MAC}/Google/Chrome`, 'Default', 'Preferences', {}, t + 5_000)

  const greeted = { version: '0.12.0', at: t + 2_000 }
  assert.deepEqual(await presence(home, greeted), { installed: true, installedIn: [] }, 'loaded just now: greeted, not yet recorded')
  assert.deepEqual(await presence(home, { ...greeted, at: t - 1_000 }), { installed: false, installedIn: [] }, 'an old greeting proves nothing')

  utimesSync(plain, (t + 9_000) / 1000, (t + 9_000) / 1000)
  assert.equal((await presence(home, greeted)).installed, true, 'the plain file churns for other reasons and does not count')

  record(home, `${MAC}/Google/Chrome`, 'Default', 'Secure Preferences', ours(), t + 10_000)
  assert.deepEqual(await presence(home, greeted), { installed: true, installedIn: ['Google Chrome'] }, 'written down')

  record(home, `${MAC}/Google/Chrome`, 'Default', 'Secure Preferences', { [EXTENSION_ID]: {} }, t + 30_000)
  assert.deepEqual(await presence(home, greeted), { installed: false, installedIn: [] }, 'removed after the greeting')
})
