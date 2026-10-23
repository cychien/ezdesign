import { fromBase64url } from './crypto'
import { HttpError } from './http'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

export interface GoogleProfile {
  sub: string
  email: string
}

export function googleAuthUrl(params: { clientId: string; redirectUri: string; state: string; nonce: string }): string {
  const url = new URL(GOOGLE_AUTH_URL)
  url.search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state: params.state,
    nonce: params.nonce,
    prompt: 'select_account',
  }).toString()
  return url.toString()
}

export async function googleProfile(params: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  nonce: string
}): Promise<GoogleProfile> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!response.ok) throw new HttpError(502, `google refused the code (${response.status})`)
  const { id_token: idToken } = (await response.json()) as { id_token?: unknown }
  if (typeof idToken !== 'string') throw new HttpError(502, 'google sent no id_token')
  return readIdToken(idToken, { clientId: params.clientId, nonce: params.nonce, now: Date.now() })
}

/** The token came straight from Google's token endpoint over TLS, so its
 *  signature needs no check (OpenID Connect Core 3.1.3.7); its claims do. */
export function readIdToken(idToken: string, expect: { clientId: string; nonce: string; now: number }): GoogleProfile {
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(idToken.split('.')[1] ?? ''))) as Record<string, unknown>
  } catch {
    throw new HttpError(502, 'google sent an unreadable id_token')
  }
  const { iss, aud, exp, nonce, sub, email, email_verified: verified } = claims
  if (typeof iss !== 'string' || !ISSUERS.has(iss) || aud !== expect.clientId) {
    throw new HttpError(401, 'id_token is not for this client')
  }
  if (typeof exp !== 'number' || exp * 1000 <= expect.now) throw new HttpError(401, 'id_token expired')
  if (nonce !== expect.nonce) throw new HttpError(401, 'id_token nonce mismatch')
  if (typeof sub !== 'string' || typeof email !== 'string' || verified !== true) {
    throw new HttpError(401, 'google account has no verified email')
  }
  return { sub, email: email.trim().toLowerCase() }
}
