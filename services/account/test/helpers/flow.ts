import { SELF, env } from 'cloudflare:test'
import { pkceChallenge, randomSecret } from '../../src/crypto'

export const BASE = 'https://account.test'
export const REDIRECT_URI = 'http://127.0.0.1:54321/__ezdesign/account/callback'

// The pool does not isolate storage between tests, so each one starts by emptying what the last one wrote.
export async function resetState(): Promise<void> {
  await env.DB.batch(
    ['sessions', 'auth_codes', 'login_requests', 'users'].map((table) => env.DB.prepare(`delete from ${table}`)),
  )
}

let ipCounter = 0
export function freshIp(): string {
  ipCounter += 1
  return `203.0.113.${ipCounter % 250}`
}

export interface Started {
  loginPath: string
  verifier: string
  state: string
}

export async function authorize(overrides: Record<string, string> = {}): Promise<Response> {
  const verifier = randomSecret()
  const params = new URLSearchParams({
    client_id: 'ezdesign',
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    state: 'state-1',
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    ...overrides,
  })
  return SELF.fetch(`${BASE}/authorize?${params}`, { redirect: 'manual' })
}

export async function start(): Promise<Started> {
  const verifier = randomSecret()
  const state = randomSecret()
  const params = new URLSearchParams({
    client_id: 'ezdesign',
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  })
  const response = await SELF.fetch(`${BASE}/authorize?${params}`, { redirect: 'manual' })
  return { loginPath: response.headers.get('location')!, verifier, state }
}

export function submit(
  loginPath: string,
  form: { mode: 'signin' | 'signup'; email: string; password: string },
  ip: string,
): Promise<Response> {
  return SELF.fetch(`${BASE}${loginPath}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
    body: new URLSearchParams(form),
  })
}

export function callback(response: Response): { code: string; state: string; target: string } {
  const location = new URL(response.headers.get('location')!)
  return {
    code: location.searchParams.get('code')!,
    state: location.searchParams.get('state')!,
    target: `${location.origin}${location.pathname}`,
  }
}

export function exchange(code: string, verifier: string, redirectUri = REDIRECT_URI): Promise<Response> {
  return SELF.fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'ezdesign',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  })
}

export async function signUp(email: string, password = 'correct horse'): Promise<string> {
  const { loginPath, verifier } = await start()
  const { code } = callback(await submit(loginPath, { mode: 'signup', email, password }, freshIp()))
  const body = (await (await exchange(code, verifier)).json()) as { access_token: string }
  return body.access_token
}

export function me(token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
}
