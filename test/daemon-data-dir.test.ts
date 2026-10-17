import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, delay, waitFor } from './helpers/daemon.js'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Two data dirs, one control range: the setup the docs used to forbid.
const a = await DaemonWorld.create()
const b = new DaemonWorld(a.controlPort)
after(() => Promise.all([a.dispose(), b.dispose()]))

test('daemons on different data dirs share a control range without adopting each other', async () => {
  a.spawnDaemon()
  const ownA = await a.liveDaemon()
  b.spawnDaemon()
  const ownB = await b.liveDaemon()
  assert.notEqual(ownB.pid, ownA.pid)
  assert.deepEqual([ownA.port, ownB.port], [a.controlPort, a.controlPort + 1])

  await a.openSession(ownA.port, { url: 'http://127.0.0.1:21/', project: a.dataDir })
  await b.openSession(ownB.port, { url: 'http://127.0.0.1:22/', project: b.dataDir })
  const statusA = await a.cli('status')
  const statusB = await b.cli('status')
  assert.match(statusA, new RegExp(`pid ${ownA.pid}, control port ${ownA.port}\\)`))
  assert.match(statusA, /session: http:\/\/127\.0\.0\.1:21 /)
  assert.doesNotMatch(statusA, /127\.0\.0\.1:22 /)
  assert.match(statusB, new RegExp(`pid ${ownB.pid}, control port ${ownB.port}\\)`))
  assert.match(statusB, /session: http:\/\/127\.0\.0\.1:22 /)
  assert.doesNotMatch(statusB, /127\.0\.0\.1:21 /)

  assert.equal(await b.cli('stop'), 'daemon stopped\n')
  await waitFor(async () => !alive(ownB.pid), "B's daemon to exit")
  assert.ok(alive(ownA.pid), "stopping B leaves A's daemon running")
  assert.match(await a.cli('status'), new RegExp(`pid ${ownA.pid},`))

  assert.equal(await a.cli('stop'), 'daemon stopped\n')
  await waitFor(async () => !alive(ownA.pid), "A's daemon to exit")
})

test('cold starts on both data dirs at once leave one daemon for each', async () => {
  for (let i = 0; i < 3; i++) {
    a.spawnDaemon()
    b.spawnDaemon()
  }
  const ownA = await a.liveDaemon()
  const ownB = await b.liveDaemon()
  const deadline = Date.now() + 8000
  while ((a.children.size > 1 || b.children.size > 1) && Date.now() < deadline) await delay(100)

  assert.deepEqual([...a.children].map((c) => c.pid), [ownA.pid])
  assert.deepEqual([...b.children].map((c) => c.pid), [ownB.pid])
  await a.stopDaemon(ownA.port)
  await b.stopDaemon(ownB.port)
})

// What an earlier build's cross-adoption left behind: B's registry naming A's daemon.
test("a registry naming another data dir's daemon is not this one's to use or stop", async () => {
  a.spawnDaemon()
  const ownA = await a.liveDaemon()
  writeFileSync(join(b.dataDir, 'daemon.json'), JSON.stringify({ ...ownA, startedAt: Date.now() }))

  assert.equal(await b.cli('status'), 'daemon: not running\n')
  assert.equal(await b.cli('stop'), 'daemon: not running\n')
  assert.ok(alive(ownA.pid))
  assert.equal(b.registry(), null)

  await a.stopDaemon(ownA.port)
})
