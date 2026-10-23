import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { base64url } from '../src/crypto'
import { GOOGLE_TOKEN_URL, readIdToken } from '../src/google'
import { BASE, REDIRECT_URI, callback, exchange, me, resetState, signUp, start } from './helpers/flow'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const NOW = Date.UTC(2026, 9, 24)

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`
}

const claims = (nonce: string, overrides: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 300,
  sub: 'google-sub-1',
  email: 'Ada@Example.com',
  email_verified: true,
  nonce,
  ...overrides,
})

function googleAnswers(overrides: Record<string, unknown> = {}) {
  const real = globalThis.fetch
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== GOOGLE_TOKEN_URL) return real(input, init)
    const sent = new URLSearchParams(String(init?.body))
    expect(sent.get('client_secret')).toBe('test-google-secret')
    expect(sent.get('redirect_uri')).toBe(`${BASE}/google/callback`)
    return Response.json({ id_token: idToken(claims(pendingNonce, overrides)) })
  })
}

let pendingNonce = ''

async function signInWithGoogle(googleQuery: Record<string, string> = { code: 'google-code' }) {
  const started = await start()
  const toGoogle = await SELF.fetch(`${BASE}${started.loginPath}/google`, { redirect: 'manual' })
  expect(toGoogle.status).toBe(303)
  const googleUrl = new URL(toGoogle.headers.get('location')!)
  const state = googleUrl.searchParams.get('state')!
  pendingNonce = googleUrl.searchParams.get('nonce')!
  const cookie = toGoogle.headers.get('set-cookie')!.split(';')[0]!
  const back = await SELF.fetch(`${BASE}/google/callback?${new URLSearchParams({ state, ...googleQuery })}`, {
    redirect: 'manual',
    headers: { cookie },
  })
  return { started, googleUrl, back }
}

describe('Google sign-in', () => {
  beforeEach(resetState)
  afterEach(() => vi.restoreAllMocks())

  it('sends the browser to Google for an email, bound to a cookie', async () => {
    const started = await start()
    const response = await SELF.fetch(`${BASE}${started.loginPath}/google`, { redirect: 'manual' })
    const url = new URL(response.headers.get('location')!)
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('scope')).toBe('openid email')
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/google/callback`)
    expect(url.searchParams.get('state')).toBe(`${started.loginPath.split('/')[2]}.${url.searchParams.get('nonce')}`)
    expect(response.headers.get('set-cookie')).toMatch(
      /^ez_google=[^;]+; Max-Age=900; Path=\/google; HttpOnly; Secure; SameSite=Lax$/,
    )
  })

  it('creates a verified account and hands the loopback a code', async () => {
    googleAnswers()
    const { started, back } = await signInWithGoogle()
    expect(back.status).toBe(303)
    const { code, state, target } = callback(back)
    expect(target).toBe(REDIRECT_URI)
    expect(state).toBe(started.state)

    const body = (await (await exchange(code, started.verifier)).json()) as { user: { email: string } }
    expect(body.user.email).toBe('ada@example.com')
    const row = await env.DB.prepare('select email_verified, google_sub, password_hash from users').first()
    expect(row).toEqual({ email_verified: 1, google_sub: 'google-sub-1', password_hash: null })
  })

  it('comes back to the same account the next time', async () => {
    googleAnswers()
    await signInWithGoogle()
    await signInWithGoogle()
    const { results } = await env.DB.prepare('select id from users').all()
    expect(results).toHaveLength(1)
  })

  it('takes over an unproven password account with its email, dropping its password and sessions', async () => {
    const squatter = await signUp('ada@example.com')
    googleAnswers()
    const { back } = await signInWithGoogle()
    expect(back.status).toBe(303)

    const row = await env.DB.prepare('select email_verified, google_sub, password_hash from users').first()
    expect(row).toEqual({ email_verified: 1, google_sub: 'google-sub-1', password_hash: null })
    expect((await me(squatter)).status).toBe(401)
  })

  it('refuses a callback from a browser that did not start it', async () => {
    const started = await start()
    const toGoogle = await SELF.fetch(`${BASE}${started.loginPath}/google`, { redirect: 'manual' })
    const state = new URL(toGoogle.headers.get('location')!).searchParams.get('state')!
    const response = await SELF.fetch(`${BASE}/google/callback?state=${encodeURIComponent(state)}&code=x`, {
      redirect: 'manual',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Google 登入沒有完成')
  })

  it('puts the login page back when the person cancels at Google', async () => {
    const { back } = await signInWithGoogle({ error: 'access_denied' })
    expect(back.status).toBe(200)
    expect(await back.text()).toContain('Google 登入已取消。')
  })

  it('puts the login page back when Google vouches for no email', async () => {
    googleAnswers({ email_verified: false })
    const { back } = await signInWithGoogle()
    expect(back.status).toBe(502)
    expect(await back.text()).toContain('Google 登入沒有成功，請再試一次。')
  })
})

describe('readIdToken', () => {
  const expect_ = { clientId: CLIENT_ID, nonce: 'n-1', now: NOW }
  const at = (overrides: Record<string, unknown>) =>
    idToken({ ...claims('n-1'), exp: NOW / 1000 + 60, ...overrides })

  it('reads the subject and a lowercased email', () => {
    expect(readIdToken(at({}), expect_)).toEqual({ sub: 'google-sub-1', email: 'ada@example.com' })
  })

  it.each([
    ['another audience', { aud: 'someone-else' }, 'id_token is not for this client'],
    ['another issuer', { iss: 'https://evil.example' }, 'id_token is not for this client'],
    ['an expired token', { exp: NOW / 1000 - 1 }, 'id_token expired'],
    ['another nonce', { nonce: 'n-2' }, 'id_token nonce mismatch'],
    ['an unverified email', { email_verified: false }, 'google account has no verified email'],
  ])('refuses %s', (_name, overrides, message) => {
    expect(() => readIdToken(at(overrides), expect_)).toThrow(message)
  })
})
