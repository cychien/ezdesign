import { pkceChallenge, randomId, randomSecret, sha256Hex } from './crypto'
import type { User } from './env'
import { isoIn, nowIso } from './http'

export const CLIENT_ID = 'ezdesign'
const LOGIN_REQUEST_TTL_MS = 15 * 60_000
const CODE_TTL_MS = 60_000
const LOOPBACK_CALLBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/__ezdesign\/account\/callback$/
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const MAX_STATE = 512

export interface LoginRequest {
  id: string
  redirect_uri: string
  state: string
  code_challenge: string
}

export function isLoopbackCallback(uri: string): boolean {
  const port = LOOPBACK_CALLBACK.exec(uri)?.[1]
  return port !== undefined && Number(port) > 0 && Number(port) < 65_536
}

export function authorizeProblem(query: Record<string, string | undefined>): string | null {
  if (query['client_id'] !== CLIENT_ID) return 'unknown client'
  if (query['response_type'] !== 'code') return 'response_type must be code'
  if (!query['redirect_uri'] || !isLoopbackCallback(query['redirect_uri'])) return 'redirect_uri is not an ezdesign callback'
  if (!query['state'] || query['state'].length > MAX_STATE) return 'state is missing'
  if (query['code_challenge_method'] !== 'S256') return 'code_challenge_method must be S256'
  if (!query['code_challenge'] || !CHALLENGE.test(query['code_challenge'])) return 'code_challenge is malformed'
  return null
}

export async function createLoginRequest(
  db: D1Database,
  request: Omit<LoginRequest, 'id'>,
): Promise<string> {
  const id = randomId()
  await db.batch([
    db.prepare('delete from login_requests where expires_at < ?').bind(nowIso()),
    db
      .prepare('insert into login_requests (id, redirect_uri, state, code_challenge, expires_at) values (?, ?, ?, ?, ?)')
      .bind(id, request.redirect_uri, request.state, request.code_challenge, isoIn(LOGIN_REQUEST_TTL_MS)),
  ])
  return id
}

export function loginRequest(db: D1Database, id: string): Promise<LoginRequest | null> {
  return db
    .prepare('select id, redirect_uri, state, code_challenge from login_requests where id = ? and expires_at > ?')
    .bind(id, nowIso())
    .first<LoginRequest>()
}

export async function finishLogin(db: D1Database, request: LoginRequest, user: User): Promise<string> {
  const code = randomSecret()
  await db.batch([
    db.prepare('delete from login_requests where id = ?').bind(request.id),
    db
      .prepare('insert into auth_codes (code_hash, user_id, redirect_uri, code_challenge, expires_at) values (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(code), user.id, request.redirect_uri, request.code_challenge, isoIn(CODE_TTL_MS)),
  ])
  const target = new URL(request.redirect_uri)
  target.searchParams.set('code', code)
  target.searchParams.set('state', request.state)
  return target.toString()
}

export async function redeemCode(
  db: D1Database,
  grant: { code: string; verifier: string; redirectUri: string },
): Promise<string | null> {
  const row = await db
    .prepare(
      `update auth_codes set used_at = ? where code_hash = ? and used_at is null and expires_at > ?
       returning user_id, redirect_uri, code_challenge`,
    )
    .bind(nowIso(), await sha256Hex(grant.code), nowIso())
    .first<{ user_id: string; redirect_uri: string; code_challenge: string }>()
  if (!row || row.redirect_uri !== grant.redirectUri) return null
  return (await pkceChallenge(grant.verifier)) === row.code_challenge ? row.user_id : null
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = randomSecret('eza_')
  await db
    .prepare('insert into sessions (id, user_id, token_hash, created_at) values (?, ?, ?, ?)')
    .bind(randomId(), userId, await sha256Hex(token), nowIso())
    .run()
  return token
}

export async function sessionFor(db: D1Database, token: string): Promise<{ sessionId: string; user: User } | null> {
  const row = await db
    .prepare(
      `select sessions.id as session_id, users.id, users.email from sessions join users on users.id = sessions.user_id
       where sessions.token_hash = ? and sessions.revoked_at is null`,
    )
    .bind(await sha256Hex(token))
    .first<{ session_id: string; id: string; email: string }>()
  return row && { sessionId: row.session_id, user: { id: row.id, email: row.email } }
}

export async function revokeSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('update sessions set revoked_at = ? where id = ?').bind(nowIso(), sessionId).run()
}

export function userById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare('select id, email from users where id = ?').bind(id).first<User>()
}
