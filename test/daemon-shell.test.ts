import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld } from './helpers/daemon.js'

const world = new DaemonWorld(4530)

let app: Server
after(async () => {
  await world.dispose()
  app?.close()
})

test('the shell tab icon loads from the daemon, not from a dev app that has none', async () => {
  app = createServer((req, res) => {
    if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>')
    else res.writeHead(404).end()
  })
  await new Promise<void>((ok) => app.listen(0, '127.0.0.1', ok))
  const appUrl = `http://localhost:${(app.address() as AddressInfo).port}`

  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { shellUrl } = await world.openSession(control, {
    url: appUrl,
    project: mkdtempSync(join(world.dataDir, 'project-')),
  })

  const html = await (await fetch(shellUrl)).text()
  const declared = html.match(/<link rel="icon" href="([^"]+)">/)?.[1]
  const icon = await fetch(new URL(declared ?? '/favicon.ico', shellUrl))

  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml')
})
