import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld } from './helpers/daemon.js'

const world = await DaemonWorld.create()
after(() => world.dispose())

test('CV-csrf-refused: a browser on another site cannot act on the session api', async () => {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const project = realpathSync(mkdtempSync(join(world.dataDir, 'project-')))
  const { port } = await world.openSession(control, { url: 'http://127.0.0.1:9/', project })
  await world.postFeedback(port, 'queued before the attack')
  const shell = `http://127.0.0.1:${port}`
  const before = await world.state(port)

  const attacks: [string, Record<string, string>][] = [
    ['/end', { 'sec-fetch-site': 'cross-site', origin: 'http://localhost:4000', 'content-type': 'application/x-www-form-urlencoded' }],
    ['/send', { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' }],
    ['/acp/cancel', { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1234' }],
    ['/end', { origin: 'http://evil.example' }],
    ['/end', { 'sec-fetch-site': 'cross-site' }],
  ]
  for (const [path, headers] of attacks) {
    const res = await fetch(`${shell}/__ezdesign/api${path}`, { method: 'POST', headers, body: 'by=user' })
    assert.equal(res.status, 403, `${path} ${JSON.stringify(headers)}`)
    assert.deepEqual(await res.json(), { error: 'cross-site request refused' })
  }
  assert.deepEqual(await world.state(port), before)

  const own = await fetch(`${shell}/__ezdesign/api/annotations`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', origin: shell, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'element', comment: 'from the shell', anchor: { selector: 'h1' } }),
  })
  assert.equal(own.status, 200)
  const events = await fetch(`${shell}/__ezdesign/api/events`, {
    headers: { 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(events.status, 200)
  await events.body?.cancel()

  const progress = await world.run(['progress', 'still mine'], { cwd: project })
  assert.equal(progress.code, 0, progress.stderr)
  const after = (await world.state(port)) as { state: string; agentProgress?: string; annotations: unknown[] }
  assert.equal(after.state, 'active')
  assert.equal(after.agentProgress, 'still mine')
  assert.equal(after.annotations.length, 1)
})
