import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ADA, type FakeAccountService, fakeAccountService } from './helpers/account.js'
import { DaemonWorld } from './helpers/daemon.js'

const world = await DaemonWorld.create()
let service: FakeAccountService
let origin = ''
let otherOrigin = ''

before(async () => {
  service = await fakeAccountService()
  world.env.EZDESIGN_API_URL = service.url
  world.env.EZDESIGN_ACCOUNT = '1'
  world.spawnDaemon()
  const { port } = await world.liveDaemon()
  const open = async () => {
    const { shellUrl } = await world.openSession(port, { project: mkdtempSync(join(world.dataDir, 'project-')) })
    return new URL(shellUrl).origin
  }
  origin = await open()
  otherOrigin = await open()
})

after(async () => {
  await world.dispose()
  await service.close()
})

const state = async (at: string) => (await (await fetch(`${at}/__ezdesign/api/state`)).json()) as { account?: unknown }

test('signs in from the shell through the service and back to this session, and every shell hears it', async () => {
  const login = await fetch(`${origin}/__ezdesign/api/account/login`, { redirect: 'manual' })
  assert.equal(login.status, 303)
  const authorize = new URL(login.headers.get('location')!)
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${service.url}/authorize`)
  assert.equal(authorize.searchParams.get('redirect_uri'), `${origin}/__ezdesign/account/callback`)

  const back = await fetch(
    `${origin}/__ezdesign/account/callback?code=code-1&state=${authorize.searchParams.get('state')}`,
    { headers: { 'sec-fetch-site': 'cross-site' } },
  )
  assert.equal(back.status, 200)
  assert.match(await back.text(), /已登入 ezdesign[\s\S]*以 ada@example\.com 登入/)

  const file = join(world.dataDir, 'credentials.json')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { account: { token: 'eza_ada', user: ADA } })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual((await state(origin)).account, { email: 'ada@example.com' })
  assert.deepEqual((await state(otherOrigin)).account, { email: 'ada@example.com' })

  const out = await fetch(`${origin}/__ezdesign/api/account/logout`, { method: 'POST' })
  assert.deepEqual(await out.json(), { ok: true })
  assert.equal(service.requests.at(-1)!.route, 'POST /v1/logout')
  assert.deepEqual((await state(origin)).account, { email: null })
  assert.deepEqual((await state(otherOrigin)).account, { email: null })
})

test('a callback this daemon did not start signs nobody in', async () => {
  const back = await fetch(`${origin}/__ezdesign/account/callback?code=code-1&state=made-up`)
  assert.equal(back.status, 400)
  assert.match(await back.text(), /這個登入已經失效/)
  assert.deepEqual((await state(origin)).account, { email: null })
})

test('no other site can start or end a sign-in', async () => {
  const headers = { 'sec-fetch-site': 'cross-site' }
  assert.equal((await fetch(`${origin}/__ezdesign/api/account/login`, { headers, redirect: 'manual' })).status, 403)
  assert.equal((await fetch(`${origin}/__ezdesign/api/account/logout`, { method: 'POST', headers })).status, 403)
})
