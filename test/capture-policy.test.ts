import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chooseHostNode, hostWrapperScript } from '../src/capture-install/index.js'
import { ALLOWED_ORIGINS } from '../src/capture-wire.js'
import { normalizeTag, tagKey, thumbnailSize } from '../src/library/policy.js'
import { checkCaller } from '../src/native-host/caller.js'

test('tags are trimmed and compared case-insensitively', () => {
  assert.equal(normalizeTag('  Hero   Section '), 'Hero Section')
  assert.equal(normalizeTag('   '), null)
  assert.equal(normalizeTag('a,b'), null)
  assert.equal(normalizeTag('a，b'), null)
  assert.equal(normalizeTag('x'.repeat(64)), 'x'.repeat(64))
  assert.equal(normalizeTag('x'.repeat(65)), null)
  assert.equal(tagKey('Hero'), tagKey(' hero'))
  assert.equal(tagKey('Landing Page'), tagKey('landing  page'))
  assert.equal(tagKey('ＵＩ'), tagKey('ui'))
  assert.notEqual(tagKey('按鈕'), tagKey('按钮'))
})

test('thumbnails keep their aspect, cap the long side at 400 and never upscale', () => {
  assert.deepEqual(thumbnailSize(4000, 3000), { width: 400, height: 300 })
  assert.deepEqual(thumbnailSize(300, 9000), { width: 13, height: 400 })
  assert.deepEqual(thumbnailSize(120, 80), { width: 120, height: 80 })
  assert.deepEqual(thumbnailSize(10_000, 1), { width: 400, height: 1 })
})

test('the host refuses a caller that is not the pinned extension', () => {
  assert.deepEqual(checkCaller(['node', 'host.mjs', ALLOWED_ORIGINS[0]!]), { ok: true, origin: ALLOWED_ORIGINS[0] })
  assert.equal(checkCaller(['node', 'host.mjs', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']).ok, false)
  assert.equal(checkCaller(['node', 'host.mjs']).ok, false)
})

test('the host node is the running one when it can open the library, else the recorded one', () => {
  const current = { path: '/n/24/bin/node', version: 'v24.19.0' }
  const old = { path: '/n/20/bin/node', version: 'v20.18.0' }
  assert.deepEqual(chooseHostNode(current, old), { ok: true, node: current })
  assert.deepEqual(chooseHostNode(old, current), { ok: true, node: current })
  assert.deepEqual(chooseHostNode(old, { path: '/gone', version: null }), {
    ok: false,
    reason: 'the capture host needs Node >= 22.13.0; this is v20.18.0 at /n/20/bin/node',
  })
})

test('the wrapper starts the host with no PATH, the data dir pinned and the origin passed on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ezdesign-wrapper-'))
  const host = join(dir, "the host's dir", 'host.mjs')
  mkdirSync(join(dir, "the host's dir"))
  writeFileSync(host, 'console.log(JSON.stringify([process.env.EZDESIGN_DATA_DIR, process.env.PATH ?? null, process.argv[2]]))\n')
  const wrapper = join(dir, 'ezdesign-native-host')
  writeFileSync(wrapper, hostWrapperScript({ node: process.execPath, host, dataDir: join(dir, 'data dir') }))
  chmodSync(wrapper, 0o755)
  const run = spawnSync(wrapper, ['chrome-extension://x/'], { env: {}, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout), [join(dir, 'data dir'), null, 'chrome-extension://x/'])
})
