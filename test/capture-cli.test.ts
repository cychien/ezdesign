import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DaemonWorld, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
after(() => world.dispose())
const REPO = fileURLToPath(new URL('..', import.meta.url))

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

test('CX-p4-flag-removed: `extension` is a verb with no flag, in the help and in the docs', async () => {
  assert.match((await world.run(['--help'])).stdout, /\n {2}ezdesign extension install \[--user-data-dir <dir>\] \| uninstall \| status\n/)
  const before = readdirSync(world.dataDir)
  const run = await world.run(['extension', 'status'])
  assert.equal(run.code, 1)
  assert.match(run.stdout, /^host: not installed\n/)
  assert.match(run.stdout, /\nproblem: the capture host is not installed; run `ezdesign extension install`\n$/)
  assert.deepEqual(readdirSync(world.dataDir), before, 'status creates nothing')
  const unknown = await world.run(['extension', 'reinstall'])
  assert.deepEqual([unknown.code, unknown.stderr], [1, 'error: unknown extension command: reinstall\nhint: ezdesign extension install | uninstall | status\n'])

  const flag = ['EZDESIGN', 'CAPTURE'].join('_')
  const mentions = ['src', 'test', 'scripts']
    .flatMap((dir) => filesUnder(join(REPO, dir)))
    .filter((file) => readFileSync(file, 'utf8').includes(flag))
  assert.deepEqual(mentions, [])
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
  assert.match(readme, /npx -y @cychien\/ezdesign@latest extension install/)
  assert.match(readme, /Load unpacked/)
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
