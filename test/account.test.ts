import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import type { Request, Response } from 'express'
import { Account, AccountError, accountBaseUrl, requireAccount } from '../src/account.js'
import { credentialsFile, readAccount, readInspireToken, writeInspireToken } from '../src/credentials.js'
import { ADA, type FakeAccountService, fakeAccountService } from './helpers/account.js'

const CALLBACK = 'http://127.0.0.1:54321/__ezdesign/account/callback'

let service: FakeAccountService
before(async () => {
  service = await fakeAccountService()
})
after(() => service.close())
beforeEach(() => {
  service.requests.length = 0
  service.answerToken = { status: 200, body: { access_token: 'eza_ada', token_type: 'Bearer', user: ADA } }
})

function account(opts: { now?: () => number } = {}) {
  const file = credentialsFile(mkdtempSync(join(tmpdir(), 'ezdesign-account-')))
  let changes = 0
  const it = new Account({ baseUrl: service.url, file, onChange: () => changes++, ...opts })
  return { it, file, changes: () => changes }
}

function stateOf(authorizeUrl: string) {
  const url = new URL(authorizeUrl)
  return { url, state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')! }
}

test('the service url defaults to account.ezdesign.dev and can be pointed elsewhere', () => {
  assert.equal(accountBaseUrl({}), 'https://account.ezdesign.dev')
  assert.equal(accountBaseUrl({ EZDESIGN_ACCOUNT_URL: 'http://127.0.0.1:8787/' }), 'http://127.0.0.1:8787')
})

test('asks the service for a code-with-PKCE login that comes back to the loopback', () => {
  const { it } = account()
  const { url, state, challenge } = stateOf(it.authorizeUrl(CALLBACK))
  assert.equal(`${url.origin}${url.pathname}`, `${service.url}/authorize`)
  assert.equal(url.searchParams.get('client_id'), 'ezdesign')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.match(state, /^[A-Za-z0-9_-]{22}$/)
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/)
})

test('trades the code with the verifier behind the challenge, and keeps the token owner-only', async () => {
  const { it, file, changes } = account()
  const { state, challenge } = stateOf(it.authorizeUrl(CALLBACK))

  assert.deepEqual(await it.complete(state, 'code-1'), ADA)

  const [sent] = service.requests
  assert.equal(sent!.route, 'POST /token')
  assert.equal(sent!.form.get('code'), 'code-1')
  assert.equal(sent!.form.get('redirect_uri'), CALLBACK)
  assert.equal(createHash('sha256').update(sent!.form.get('code_verifier')!).digest('base64url'), challenge)
  assert.deepEqual(readAccount(file), { token: 'eza_ada', user: ADA })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(it.snapshot(), { email: 'ada@example.com' })
  assert.equal(changes(), 1)
})

test('finishes each login once, and only the ones it started', async () => {
  const { it } = account()
  const { state } = stateOf(it.authorizeUrl(CALLBACK))
  await it.complete(state, 'code-1')
  await assert.rejects(it.complete(state, 'code-1'), (e: AccountError) => e.problem === 'unknown-login')
  await assert.rejects(it.complete('made-up', 'code-1'), (e: AccountError) => e.problem === 'unknown-login')
  assert.equal(service.requests.length, 1)
})

test('forgets a login nobody finished within fifteen minutes', async () => {
  let now = 0
  const { it } = account({ now: () => now })
  const { state } = stateOf(it.authorizeUrl(CALLBACK))
  now = 15 * 60_000 + 1
  await assert.rejects(it.complete(state, 'code-1'), (e: AccountError) => e.problem === 'unknown-login')
})

test('stays signed out when the service refuses the code', async () => {
  service.answerToken = { status: 400, body: { error: 'invalid_grant' } }
  const { it, file, changes } = account()
  const { state } = stateOf(it.authorizeUrl(CALLBACK))
  await assert.rejects(it.complete(state, 'code-1'), (e: AccountError) => e.problem === 'refused')
  assert.equal(it.snapshot(), undefined)
  assert.equal(existsSync(file), false)
  assert.equal(changes(), 0)
})

test('signs out here and at the service, and leaves the inspiration token alone', async () => {
  const { it, file } = account()
  writeInspireToken('tok_inspire', file)
  await it.complete(stateOf(it.authorizeUrl(CALLBACK)).state, 'code-1')

  await it.signOut()

  const logout = service.requests.at(-1)!
  assert.deepEqual([logout.route, logout.authorization], ['POST /v1/logout', 'Bearer eza_ada'])
  assert.equal(readAccount(file), null)
  assert.equal(it.snapshot(), undefined)
  assert.equal(readInspireToken(file), 'tok_inspire')
})

test('signs out locally even when the service cannot be reached', async () => {
  const file = credentialsFile(mkdtempSync(join(tmpdir(), 'ezdesign-account-')))
  const signedIn = new Account({ baseUrl: service.url, file, onChange: () => {} })
  await signedIn.complete(stateOf(signedIn.authorizeUrl(CALLBACK)).state, 'code-1')
  const offline = new Account({ baseUrl: 'http://127.0.0.1:9', file, onChange: () => {} })
  assert.deepEqual(offline.user, ADA)
  await offline.signOut()
  assert.equal(readAccount(file), null)
})

test('calls signed-in apis with the token, and a refused token signs the daemon out', async () => {
  const { it, changes } = account()
  await it.complete(stateOf(it.authorizeUrl(CALLBACK)).state, 'code-1')
  assert.equal((await it.fetchOrSignOut('/v1/me')).status, 200)
  assert.equal(service.requests.at(-1)!.authorization, 'Bearer eza_ada')

  const stale = account()
  service.answerToken = { status: 200, body: { access_token: 'eza_revoked', token_type: 'Bearer', user: ADA } }
  await stale.it.complete(stateOf(stale.it.authorizeUrl(CALLBACK)).state, 'code-2')
  assert.equal((await stale.it.fetchOrSignOut('/v1/me')).status, 401)
  assert.equal(stale.it.user, null)
  assert.equal(stale.changes(), 2)
  await assert.rejects(stale.it.fetchOrSignOut('/v1/me'), (e: AccountError) => e.problem === 'signed-out')
  assert.equal(changes(), 1)
})

test('a route behind requireAccount answers 401 until someone signs in', async () => {
  const { it } = account()
  const gate = requireAccount(it)
  const call = () => {
    let passed = false
    let answered: { status: number; body: unknown } | null = null
    const res = {
      status(code: number) {
        return { json: (body: unknown) => (answered = { status: code, body }) }
      },
    } as unknown as Response
    gate({} as Request, res, () => (passed = true))
    return { passed, answered }
  }
  assert.deepEqual(call(), {
    passed: false,
    answered: { status: 401, body: { error: 'sign in to ezdesign first', problem: 'signed-out' } },
  })
  await it.complete(stateOf(it.authorizeUrl(CALLBACK)).state, 'code-1')
  assert.deepEqual(call(), { passed: true, answered: null })
})
