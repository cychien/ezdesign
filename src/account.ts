import { createHash, randomBytes } from 'node:crypto'
import type { RequestHandler } from 'express'
import { APP_NAME, URL_PREFIX } from './constants.js'
import { type AccountCredential, clearAccount, credentialsFile, readAccount, writeAccount } from './credentials.js'

export const DEFAULT_ACCOUNT_URL = 'https://account.ezdesign.dev'
export const ACCOUNT_URL_ENV = `${APP_NAME.toUpperCase()}_ACCOUNT_URL`
export const ACCOUNT_CALLBACK_PATH = `${URL_PREFIX}/account/callback`
const CLIENT_ID = APP_NAME
const LOGIN_REQUEST_TTL_MS = 15 * 60_000
const REQUEST_TIMEOUT_MS = 15_000

export type AccountUser = AccountCredential['user']

export interface AccountWire {
  email: string
}

export type AccountProblem = 'unknown-login' | 'refused' | 'unreachable' | 'signed-out'

export class AccountError extends Error {
  constructor(
    readonly problem: AccountProblem,
    message: string,
  ) {
    super(message)
  }
}

export function accountBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[ACCOUNT_URL_ENV]?.trim()
  return (raw || DEFAULT_ACCOUNT_URL).replace(/\/+$/, '')
}

const base64url = (bytes: Buffer) => bytes.toString('base64url')

export interface AccountDeps {
  baseUrl: string
  onChange: () => void
  file?: string
  fetch?: typeof fetch
  now?: () => number
}

export class Account {
  private credential: AccountCredential | null
  private readonly pendingByState = new Map<string, { verifier: string; redirectUri: string; at: number }>()
  private readonly file: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: AccountDeps) {
    this.file = deps.file ?? credentialsFile()
    this.fetchImpl = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
    this.credential = readAccount(this.file)
  }

  get user(): AccountUser | null {
    return this.credential?.user ?? null
  }

  snapshot(): AccountWire | undefined {
    return this.credential ? { email: this.credential.user.email } : undefined
  }

  authorizeUrl(redirectUri: string): string {
    this.dropStale()
    const verifier = base64url(randomBytes(32))
    const state = base64url(randomBytes(16))
    this.pendingByState.set(state, { verifier, redirectUri, at: this.now() })
    const url = new URL(`${this.deps.baseUrl}/authorize`)
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    }).toString()
    return url.toString()
  }

  async complete(state: string, code: string): Promise<AccountUser> {
    this.dropStale()
    const login = this.pendingByState.get(state)
    if (!login) throw new AccountError('unknown-login', 'no login is waiting for this answer')
    this.pendingByState.delete(state)
    const response = await this.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: login.verifier,
        redirect_uri: login.redirectUri,
      }),
    })
    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown
      user?: { id?: unknown; email?: unknown }
    } | null
    const { access_token: token, user } = body ?? {}
    if (!response.ok || typeof token !== 'string' || typeof user?.id !== 'string' || typeof user.email !== 'string') {
      throw new AccountError('refused', `the account service refused the sign-in (${response.status})`)
    }
    this.remember({ token, user: { id: user.id, email: user.email } })
    return this.credential!.user
  }

  async signOut(): Promise<void> {
    const credential = this.credential
    if (!credential) return
    this.remember(null)
    await this.request('/v1/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.token}` },
    }).catch(() => undefined)
  }

  async fetchOrSignOut(path: string, init: RequestInit = {}): Promise<Response> {
    const credential = this.credential
    if (!credential) throw new AccountError('signed-out', 'sign in to ezdesign first')
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${credential.token}`)
    const response = await this.request(path, { ...init, headers })
    if (response.status === 401 && this.credential === credential) this.remember(null)
    return response
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.deps.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new AccountError('unreachable', `cannot reach ${this.deps.baseUrl}: ${(error as Error).message}`)
    }
  }

  private remember(credential: AccountCredential | null): void {
    this.credential = credential
    if (credential) writeAccount(credential, this.file)
    else clearAccount(this.file)
    this.deps.onChange()
  }

  private dropStale(): void {
    for (const [state, login] of this.pendingByState) {
      if (this.now() - login.at > LOGIN_REQUEST_TTL_MS) this.pendingByState.delete(state)
    }
  }
}

export function requireAccount(account: Account): RequestHandler {
  return (_req, res, next) => {
    if (account.user) return next()
    res.status(401).json({ error: 'sign in to ezdesign first', problem: 'signed-out' satisfies AccountProblem })
  }
}
