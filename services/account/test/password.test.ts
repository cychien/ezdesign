import { SELF, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BASE,
  REDIRECT_URI,
  authorize,
  callback,
  exchange,
  freshIp,
  me,
  resetState,
  signUp,
  start,
  submit,
} from './helpers/flow'

describe('authorize', () => {
  beforeEach(resetState)

  it('sends a valid request on to its login page', async () => {
    const response = await authorize()
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toMatch(/^\/login\/[0-9a-f]{32}$/)
  })

  it.each([
    ['a redirect off the loopback', { redirect_uri: 'https://evil.example/__ezdesign/account/callback' }],
    ['localhost instead of 127.0.0.1', { redirect_uri: 'http://localhost:54321/__ezdesign/account/callback' }],
    ['another path on the loopback', { redirect_uri: 'http://127.0.0.1:54321/steal' }],
    ['another client', { client_id: 'someone-else' }],
    ['a plain challenge', { code_challenge_method: 'plain' }],
  ])('refuses %s and remembers nothing', async (_name, overrides) => {
    const response = await authorize(overrides)
    expect(response.status).toBe(400)
    const { results } = await env.DB.prepare('select id from login_requests').all()
    expect(results).toEqual([])
  })

  it('answers a login page nobody asked for with 410', async () => {
    const response = await SELF.fetch(`${BASE}/login/0123456789abcdef0123456789abcdef`)
    expect(response.status).toBe(410)
    expect(await response.text()).toContain('登入連結已過期')
  })
})

describe('password sign-up and sign-in', () => {
  beforeEach(resetState)

  it('signs up, hands back a code for the loopback, and trades it for a token', async () => {
    const { loginPath, verifier, state } = await start()
    const response = await submit(loginPath, { mode: 'signup', email: ' Ada@Example.com ', password: 'correct horse' }, freshIp())

    expect(response.status).toBe(303)
    const back = callback(response)
    expect(back.target).toBe(REDIRECT_URI)
    expect(back.state).toBe(state)

    const token = await exchange(back.code, verifier)
    expect(token.status).toBe(200)
    const body = (await token.json()) as { access_token: string; token_type: string; user: { email: string } }
    expect(body.token_type).toBe('Bearer')
    expect(body.access_token).toMatch(/^eza_[A-Za-z0-9_-]{43}$/)
    expect(body.user.email).toBe('ada@example.com')

    const row = await env.DB.prepare('select password_hash, email_verified from users').first<{
      password_hash: string
      email_verified: number
    }>()
    expect(row!.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/)
    expect(row!.email_verified).toBe(0)
  })

  it('trades a code once', async () => {
    const { loginPath, verifier } = await start()
    const { code } = callback(await submit(loginPath, { mode: 'signup', email: 'ada@example.com', password: 'correct horse' }, freshIp()))
    expect((await exchange(code, verifier)).status).toBe(200)

    const again = await exchange(code, verifier)
    expect(again.status).toBe(400)
    expect(await again.json()).toEqual({ error: 'invalid_grant' })
  })

  it('refuses a code without the verifier it was issued for', async () => {
    const { loginPath } = await start()
    const { code } = callback(await submit(loginPath, { mode: 'signup', email: 'ada@example.com', password: 'correct horse' }, freshIp()))
    const response = await exchange(code, 'not-the-verifier-not-the-verifier-not-the-v')
    expect(await response.json()).toEqual({ error: 'invalid_grant' })
  })

  it('refuses a code sent with another redirect_uri', async () => {
    const { loginPath, verifier } = await start()
    const { code } = callback(await submit(loginPath, { mode: 'signup', email: 'ada@example.com', password: 'correct horse' }, freshIp()))
    const response = await exchange(code, verifier, 'http://127.0.0.1:1/__ezdesign/account/callback')
    expect(await response.json()).toEqual({ error: 'invalid_grant' })
  })

  it('spends the login request, so its page cannot sign a second person in', async () => {
    const { loginPath } = await start()
    await submit(loginPath, { mode: 'signup', email: 'ada@example.com', password: 'correct horse' }, freshIp())
    const second = await submit(loginPath, { mode: 'signin', email: 'ada@example.com', password: 'correct horse' }, freshIp())
    expect(second.status).toBe(410)
  })

  it('signs back in with the password it was given', async () => {
    await signUp('ada@example.com')
    const { loginPath, verifier, state } = await start()
    const response = await submit(loginPath, { mode: 'signin', email: 'ADA@example.com', password: 'correct horse' }, freshIp())
    expect(response.status).toBe(303)
    expect(callback(response).state).toBe(state)
    expect((await exchange(callback(response).code, verifier)).status).toBe(200)
  })

  it('says the same thing for a wrong password and an unknown email', async () => {
    await signUp('ada@example.com')
    const { loginPath } = await start()
    const wrong = await submit(loginPath, { mode: 'signin', email: 'ada@example.com', password: 'wrong password' }, freshIp())
    const unknown = await submit(loginPath, { mode: 'signin', email: 'bob@example.com', password: 'correct horse' }, freshIp())
    expect([wrong.status, unknown.status]).toEqual([401, 401])
    expect(await wrong.text()).toContain('Email 或密碼不正確。')
    expect(await unknown.text()).toContain('Email 或密碼不正確。')
  })

  it('keeps the email typed when it sends the form back', async () => {
    const { loginPath } = await start()
    const response = await submit(loginPath, { mode: 'signin', email: 'bob@example.com', password: 'x' }, freshIp())
    expect(await response.text()).toContain('value="bob@example.com"')
  })

  it('refuses a second sign-up with the same email', async () => {
    await signUp('ada@example.com')
    const { loginPath } = await start()
    const response = await submit(loginPath, { mode: 'signup', email: 'ada@example.com', password: 'another one' }, freshIp())
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('這個 email 已經註冊過了，請直接登入。')
  })

  it.each([
    ['a short password', 'ada@example.com', 'short', '密碼要 8 到 128 個字元。'],
    ['a malformed email', 'not-an-email', 'correct horse', '請輸入有效的 email。'],
  ])('refuses %s', async (_name, email, password, message) => {
    const { loginPath } = await start()
    const response = await submit(loginPath, { mode: 'signup', email, password }, freshIp())
    expect(response.status).toBe(400)
    expect(await response.text()).toContain(message)
    const { results } = await env.DB.prepare('select id from users').all()
    expect(results).toEqual([])
  })

  it('stops an address after ten attempts a minute', async () => {
    const { loginPath } = await start()
    const ip = freshIp()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      statuses.push((await submit(loginPath, { mode: 'signin', email: `nobody${i}@example.com`, password: 'x' }, ip)).status)
    }
    expect(statuses).toEqual([...Array(10).fill(401), 429])
  })
})

describe('the signed-in api', () => {
  beforeEach(resetState)

  it('says who the token belongs to', async () => {
    const token = await signUp('ada@example.com')
    const response = await me(token)
    expect(response.status).toBe(200)
    const { user } = (await response.json()) as { user: { id: string; email: string } }
    expect(user.email).toBe('ada@example.com')
    expect(user.id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('refuses a request with no token or an unknown one', async () => {
    const none = await SELF.fetch(`${BASE}/v1/me`)
    expect(none.status).toBe(401)
    expect(await none.json()).toEqual({ error: 'sign-in required' })
    const unknown = await me('eza_unknown')
    expect(await unknown.json()).toEqual({ error: 'session not recognised' })
  })

  it('stops honouring a token once it signs out', async () => {
    const token = await signUp('ada@example.com')
    const out = await SELF.fetch(`${BASE}/v1/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    expect(await out.json()).toEqual({ ok: true })
    expect((await me(token)).status).toBe(401)
  })
})
