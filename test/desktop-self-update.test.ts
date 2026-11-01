import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  SWAP_SCRIPT,
  bundleOf,
  checkBundle,
  downloadVerified,
  replaceable,
  unpackApp,
  zipFor,
} from '../desktop/src/self-update.js'

/** `codesign`, `ditto` and `open` are macOS's own. */
const macOnly = { skip: process.platform !== 'darwin' }

const tmp = () => mkdtempSync(join(tmpdir(), 'ezdesign-self-update-'))
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64')

/** A bundle shaped like the app's, ad-hoc signed as the release is. */
function fakeApp(dir: string, version: string, id = 'dev.ezdesign.app'): string {
  const app = join(dir, 'ezdesign.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>ezdesign</string></dict></plist>`,
  )
  writeFileSync(join(app, 'Contents', 'MacOS', 'ezdesign'), `#!/bin/sh\necho ${version}\n`)
  chmodSync(join(app, 'Contents', 'MacOS', 'ezdesign'), 0o755)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app])
  return app
}

test('the zip for this Mac is picked by its architecture', () => {
  const files = [
    { url: 'ezdesign-0.1.1-arm64-mac.zip', sha512: 'a' },
    { url: 'ezdesign-0.1.1-mac.zip', sha512: 'b' },
    { url: 'ezdesign-arm64.dmg', sha512: 'c' },
  ]
  assert.equal(zipFor(files, 'arm64')?.sha512, 'a')
  assert.equal(zipFor(files, 'x64')?.sha512, 'b')
  assert.equal(zipFor([{ url: 'ezdesign-arm64.dmg', sha512: 'c' }], 'arm64'), null)
})

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

test('a download that is not the release’s is refused and not kept', async () => {
  const bytes = Buffer.from('the new app')
  const server = createServer((_req, res) => res.end(bytes))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/update.zip`
  try {
    const dir = tmp()
    await downloadVerified(url, sha512(bytes), join(dir, 'good.zip'))
    assert.deepEqual(readFileSync(join(dir, 'good.zip')), bytes)
    await assert.rejects(downloadVerified(url, sha512(Buffer.from('something else')), join(dir, 'bad.zip')), /does not match/)
    assert.equal(existsSync(join(dir, 'bad.zip')), false)
  } finally {
    server.close()
  }
})

test('the unpacked update must be this app, at the version offered, with its signature whole', macOnly, async () => {
  const dir = tmp()
  const app = fakeApp(join(dir, 'build'), '0.1.1')
  const zip = join(dir, 'update.zip')
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip])
  const unpacked = await unpackApp(zip, join(dir, 'unpacked'))
  assert.ok(unpacked.endsWith('/ezdesign.app'))
  await checkBundle(unpacked, { id: 'dev.ezdesign.app', version: '0.1.1' })
  await assert.rejects(checkBundle(unpacked, { id: 'dev.ezdesign.app', version: '0.1.2' }), /another version/)
  await assert.rejects(checkBundle(unpacked, { id: 'dev.other.app', version: '0.1.1' }), /another app/)
  writeFileSync(join(unpacked, 'Contents', 'MacOS', 'ezdesign'), '#!/bin/sh\necho tampered\n')
  await assert.rejects(checkBundle(unpacked, { id: 'dev.ezdesign.app', version: '0.1.1' }))
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
