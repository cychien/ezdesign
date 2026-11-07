import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SWAP_SCRIPT, bundleOf, replaceable } from '../desktop/src/self-update.js'
import { fakeApp, macOnly } from './helpers/mac-app.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'ezdesign-self-update-'))

test('only a copy in a folder the user can write to is replaced where it is', () => {
  assert.equal(bundleOf('/Applications/ezdesign.app/Contents/MacOS/ezdesign'), '/Applications/ezdesign.app')
  assert.equal(bundleOf('/usr/local/bin/node'), null)
  const ok = () => {}
  assert.equal(replaceable('/Applications/ezdesign.app', ok), true)
  assert.equal(replaceable('/Volumes/ezdesign 0.1.0-arm64/ezdesign.app', ok), false, 'run from its disk image')
  assert.equal(replaceable('/private/var/folders/x/AppTranslocation/y/d/ezdesign.app', ok), false, 'moved aside by Gatekeeper')
  const denied = () => {
    throw new Error('EACCES')
  }
  assert.equal(replaceable('/Applications/ezdesign.app', denied), false)
})

/** Runs the swap with `open` recording what it would open. */
async function swap(current: string, next: string, waitFor: number, env: string[] = []): Promise<string> {
  const shims = tmp()
  const opened = join(shims, 'opened')
  writeFileSync(join(shims, 'open'), `#!/bin/sh\necho "$@" > "${opened}"\n`)
  chmodSync(join(shims, 'open'), 0o755)
  const child = spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'ezdesign-update', String(waitFor), current, next, ...env], {
    env: { ...process.env, PATH: `${shims}:${process.env.PATH}` },
  })
  await new Promise((r) => child.once('exit', r))
  return readFileSync(opened, 'utf8').trim()
}

test('the swap waits for the old app to exit, puts the new one in its place and opens it', macOnly, async () => {
  const dir = tmp()
  const current = fakeApp(join(dir, 'Applications'), '0.1.0')
  const next = fakeApp(join(dir, 'staged'), '0.1.1')
  const running = spawn('sleep', ['0.6'])
  const started = Date.now()
  const opened = await swap(current, next, running.pid!, ['--env', 'EZDESIGN_DATA_DIR=/tmp/x'])
  assert.ok(Date.now() - started >= 500, 'not before the old app exited')
  assert.match(readFileSync(join(current, 'Contents', 'Info.plist'), 'utf8'), /0\.1\.1/)
  assert.equal(existsSync(next), false)
  assert.equal(opened, `--env EZDESIGN_DATA_DIR=/tmp/x ${current}`)
  assert.deepEqual(readdirSync(join(dir, 'Applications')), ['ezdesign.app'], 'the old copy is gone')
})

test('a swap that cannot move the new copy in puts the old one back', macOnly, async () => {
  const dir = tmp()
  const current = fakeApp(join(dir, 'Applications'), '0.1.0')
  const opened = await swap(current, join(dir, 'missing.app'), 999_999)
  assert.match(readFileSync(join(current, 'Contents', 'Info.plist'), 'utf8'), /0\.1\.0/)
  assert.equal(opened, current)
})
