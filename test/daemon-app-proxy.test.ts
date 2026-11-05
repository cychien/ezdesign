import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld } from './helpers/daemon.js'

const world = await DaemonWorld.create()

/** An app that answers with the origin headers it was sent. */
let target: Server
after(async () => {
  await world.dispose()
  target?.close()
})

async function echoApp(): Promise<string> {
  target = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ origin: req.headers.origin ?? null, referer: req.headers.referer ?? null }))
  })
  await new Promise<void>((ok) => target.listen(0, '127.0.0.1', ok))
  return `http://localhost:${(target.address() as AddressInfo).port}`
}

test("the app sees its own origin for a request its page makes through the proxy, and a cross-site one's as sent", async () => {
  const appOrigin = await echoApp()
  world.spawnDaemon()
  const live = await world.liveDaemon()
  const { port } = await world.openSession(live.port, {
    url: `${appOrigin}/`,
    project: mkdtempSync(join(world.dataDir, 'project-')),
  })
  const proxy = `http://127.0.0.1:${port}`
  const sent = async (headers: Record<string, string>) => {
    const res = await fetch(`${proxy}/api/sign-up`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })
    return (await res.json()) as { origin: string | null; referer: string | null }
  }

  assert.deepEqual(await sent({ origin: proxy, referer: `${proxy}/sign-up?next=%2F` }), {
    origin: appOrigin,
    referer: `${appOrigin}/sign-up?next=%2F`,
  })
  assert.deepEqual(await sent({ origin: 'https://evil.example', referer: 'https://evil.example/x' }), {
    origin: 'https://evil.example',
    referer: 'https://evil.example/x',
  })
  assert.deepEqual(await sent({ origin: `${proxy}.evil.example`, referer: `${proxy}.evil.example/` }), {
    origin: `${proxy}.evil.example`,
    referer: `${proxy}.evil.example/`,
  })
  assert.deepEqual(await sent({}), { origin: null, referer: null }, 'nothing is added to a request that had none')
})
