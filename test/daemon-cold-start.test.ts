import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { DaemonWorld, delay, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
after(() => world.dispose())

test('daemons cold-started at once leave exactly one running, the one the registry names', async () => {
  const spawned = Array.from({ length: 5 }, () => world.spawnDaemon())
  const live = await world.liveDaemon()
  const deadline = Date.now() + 8000
  while (world.children.size > 1 && Date.now() < deadline) await delay(100)

  assert.deepEqual([...world.children].map((c) => c.pid), [live.pid])
  for (const child of spawned) if (child.pid !== live.pid) assert.equal(child.exitCode, 0)

  await world.stopDaemon(live.port)
  await waitFor(async () => world.children.size === 0, 'no daemon left after stop')
})
