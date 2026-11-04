import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DevServer } from '../src/dev-server/index.js'
import { waitFor } from './helpers/daemon.js'

const SERVER = `
import { createServer } from 'node:http'
const server = createServer((_req, res) => res.end('hello'))
server.listen(0, '127.0.0.1', () => console.log('  Local:   http://localhost:' + server.address().port + '/'))
`

// A server stopped by the daemon's own exit dies of the signal it was sent, and
// that exit used to read as a crash, which cleared the resume the next daemon
// restarts it from: a self-update left the user's dev server down.
test('a dev server stopped because the daemon is exiting is resumed by the next one', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ezdesign-devserver-'))
  const dir = mkdtempSync(join(tmpdir(), 'ezdesign-devserver-record-'))
  writeFileSync(join(project, 'server.mjs'), SERVER)
  const devServer = new DevServer({
    project,
    dir,
    userAttachedOrigin: () => null,
    heldElsewhere: () => false,
    attach: () => {},
    detachLeavingRecord: () => {},
    environmentReady: async () => {},
    proposingAgent: () => null,
    onChange: () => {},
  })

  assert.equal(devServer.saveCommandAndRun({ line: 'node server.mjs', cwd: '' }, 'browser'), 'started')
  await waitFor(async () => devServer.snapshot().phase === 'running', 'the dev server to be running')

  await devServer.release()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const record = JSON.parse(readFileSync(join(dir, 'dev-server.json'), 'utf8')) as { resume?: { by: string } }
  assert.deepEqual(record.resume, { by: 'browser' })
})
