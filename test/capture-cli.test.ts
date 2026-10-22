import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
after(() => world.dispose())
const flagged = { env: { EZDESIGN_CAPTURE: '1' } }

test('CX-p2-cli-regression: without the flag, `extension` is a host to open, as before', async () => {
  const before = readdirSync(world.dataDir)
  const run = await world.run(['extension', 'install'])
  assert.deepEqual(run, {
    stdout: '',
    stderr:
      'error: nothing is listening at http://extension\nhint: start your dev server first, then re-run this command\n',
    code: 1,
  })
  assert.deepEqual(readdirSync(world.dataDir), before)
  assert.equal((await world.run(['http://localhost:1'])).stderr.split('\n')[0], 'error: nothing is listening at http://localhost:1')
  assert.equal((await world.run(['nonsense-host'])).stderr.split('\n')[0], 'error: nothing is listening at http://nonsense-host')
  assert.doesNotMatch((await world.run(['--help'])).stdout, /extension/)
  assert.match(
    (await world.run(['--help'], flagged)).stdout,
    /\n {2}ezdesign extension install \[--user-data-dir <dir>\] \| uninstall \| status\n/,
  )
})

test('with the flag, status reports a missing install, exits 1 and creates nothing', async () => {
  const before = readdirSync(world.dataDir)
  const run = await world.run(['extension', 'status'], flagged)
  assert.equal(run.code, 1)
  assert.match(run.stdout, /^host: not installed\n/)
  assert.match(run.stdout, /\nproblem: the capture host is not installed; run `ezdesign extension install`\n$/)
  assert.deepEqual(readdirSync(world.dataDir), before)
  const unknown = await world.run(['extension', 'reinstall'], flagged)
  assert.deepEqual([unknown.code, unknown.stderr], [1, 'error: unknown extension command: reinstall\nhint: ezdesign extension install | uninstall | status\n'])
})

test('CX-p2-refresh-safe: a broken capture install never stops the daemon', async () => {
  const hostDir = join(world.dataDir, 'native-host')
  const extensionDir = join(world.dataDir, 'extension')
  mkdirSync(hostDir, { recursive: true })
  mkdirSync(extensionDir, { recursive: true })
  writeFileSync(join(hostDir, 'install.json'), '{"version":')
  chmodSync(extensionDir, 0o500)
  after(() => chmodSync(extensionDir, 0o700))
  const daemon = world.spawnDaemon([], { log: true })
  let log = ''
  daemon.stdout!.on('data', (d: Buffer) => (log += d))
  daemon.stderr!.on('data', (d: Buffer) => (log += d))
  const live = await world.liveDaemon()
  assert.equal((await world.control(live.port, '/control/health')).status, 200)
  await waitFor(async () => log.includes('capture extension refresh failed:'), 'the refresh failure in the log')
  const lines = log.split('\n').filter((l) => l.startsWith('capture extension refresh failed:'))
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /install\.json is not a capture install record/)
  assert.ok(existsSync(extensionDir))
})
