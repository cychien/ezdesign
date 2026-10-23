import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { randomSecret } from '../crypto'
import type { AppEnv } from '../env'
import { authorizeProblem, createLoginRequest, finishLogin, type LoginRequest, loginRequest } from '../flow'
import { googleAuthUrl, googleProfile } from '../google'
import { HttpError } from '../http'
import { type LoginMode, loginPage, messagePage } from '../page'
import { hashPassword, MAX_PASSWORD, MIN_PASSWORD, verifyPassword } from '../password'
import { createPasswordUser, findUserByEmail, googleUser, normaliseEmail } from '../users'

export const loginRoutes = new Hono<AppEnv>()

const GOOGLE_COOKIE = 'ez_google'
const GOOGLE_COOKIE_PATH = '/google'
const GOOGLE_COOKIE_TTL_S = 15 * 60

const signInLimitKeys = (mode: LoginMode, ip: string, email: string) =>
  mode === 'signin' ? [`ip:${ip}`, `email:${email}`] : [`ip:${ip}`]

const EXPIRED = ['登入連結已過期', '請回到 ezdesign 重新登入。'] as const

function page(c: Context<AppEnv>, html: string, status: ContentfulStatusCode = 200) {
  c.header('cache-control', 'no-store')
  c.header('x-frame-options', 'DENY')
  c.header(
    'content-security-policy',
    // A form post that ends in a redirect is held to form-action too, so the loopback callback is listed.
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
  )
  return c.html(html, status)
}

const googleConfigured = (c: Context<AppEnv>) => !!c.env.GOOGLE_CLIENT_SECRET
const googleCallback = (c: Context<AppEnv>) => `${new URL(c.req.url).origin}/google/callback`

function showLogin(
  c: Context<AppEnv>,
  request: LoginRequest,
  view: { mode?: LoginMode; email?: string; error?: string } = {},
  status: ContentfulStatusCode = 200,
) {
  return page(c, loginPage({ requestId: request.id, mode: view.mode ?? 'signin', ...view, google: googleConfigured(c) }), status)
}

loginRoutes.get('/authorize', async (c) => {
  const query = c.req.query()
  const problem = authorizeProblem(query)
  if (problem) return page(c, messagePage('無法登入', `這個登入連結無效（${problem}），請回到 ezdesign 再試一次。`), 400)
  const id = await createLoginRequest(c.env.DB, {
    redirect_uri: query['redirect_uri']!,
    state: query['state']!,
    code_challenge: query['code_challenge']!,
  })
  return c.redirect(`/login/${id}`, 303)
})

loginRoutes.get('/login/:id', async (c) => {
  const request = await loginRequest(c.env.DB, c.req.param('id'))
  if (!request) return page(c, messagePage(...EXPIRED), 410)
  return showLogin(c, request, { mode: c.req.query('mode') === 'signup' ? 'signup' : 'signin' })
})

loginRoutes.post('/login/:id', async (c) => {
  const request = await loginRequest(c.env.DB, c.req.param('id'))
  if (!request) return page(c, messagePage(...EXPIRED), 410)
  const body = await c.req.parseBody()
  const mode: LoginMode = body['mode'] === 'signup' ? 'signup' : 'signin'
  const rawEmail = typeof body['email'] === 'string' ? body['email'] : ''
  const password = typeof body['password'] === 'string' ? body['password'] : ''
  const retry = (error: string, status: ContentfulStatusCode) =>
    showLogin(c, request, { mode, email: rawEmail.trim(), error }, status)

  const email = normaliseEmail(rawEmail)
  if (!email) return retry('請輸入有效的 email。', 400)
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  const limits = await Promise.all(signInLimitKeys(mode, ip, email).map((key) => c.env.SIGN_IN_LIMIT.limit({ key })))
  if (limits.some((limit) => !limit.success)) return retry('嘗試太多次了，請一分鐘後再試。', 429)

  if (mode === 'signup') {
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return retry(`密碼要 ${MIN_PASSWORD} 到 ${MAX_PASSWORD} 個字元。`, 400)
    }
    const user = await createPasswordUser(c.env.DB, email, await hashPassword(password))
    if (user === 'taken') {
      const existing = await findUserByEmail(c.env.DB, email)
      return retry(
        existing?.password_hash ? '這個 email 已經註冊過了，請直接登入。' : '這個 email 已用 Google 註冊，請點「使用 Google 繼續」。',
        409,
      )
    }
    return c.redirect(await finishLogin(c.env.DB, request, user), 303)
  }

  const user = await findUserByEmail(c.env.DB, email)
  if (user && !user.password_hash) return retry('這個帳號用 Google 登入，請點「使用 Google 繼續」。', 401)
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return retry('Email 或密碼不正確。', 401)
  }
  return c.redirect(await finishLogin(c.env.DB, request, { id: user.id, email: user.email }), 303)
})

loginRoutes.get('/login/:id/google', async (c) => {
  if (!googleConfigured(c)) throw new HttpError(404, 'google sign-in is not configured')
  const request = await loginRequest(c.env.DB, c.req.param('id'))
  if (!request) return page(c, messagePage(...EXPIRED), 410)
  const nonce = randomSecret()
  const state = `${request.id}.${nonce}`
  setCookie(c, GOOGLE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: GOOGLE_COOKIE_PATH,
    maxAge: GOOGLE_COOKIE_TTL_S,
  })
  return c.redirect(googleAuthUrl({ clientId: c.env.GOOGLE_CLIENT_ID, redirectUri: googleCallback(c), state, nonce }), 303)
})

loginRoutes.get('/google/callback', async (c) => {
  const expected = getCookie(c, GOOGLE_COOKIE)
  deleteCookie(c, GOOGLE_COOKIE, { path: GOOGLE_COOKIE_PATH, secure: true })
  const state = c.req.query('state')
  if (!expected || state !== expected) {
    return page(c, messagePage('Google 登入沒有完成', '請回到 ezdesign 重新登入。'), 400)
  }
  const [requestId = '', nonce = ''] = state.split('.')
  const request = await loginRequest(c.env.DB, requestId)
  if (!request) return page(c, messagePage(...EXPIRED), 410)

  const code = c.req.query('code')
  if (c.req.query('error') || !code) return showLogin(c, request, { error: 'Google 登入已取消。' })
  let user
  try {
    const profile = await googleProfile({
      code,
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: googleCallback(c),
      nonce,
    })
    user = await googleUser(c.env.DB, profile)
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    console.error('google sign-in failed', error.message)
    const message =
      error.status === 409 ? '這個 email 已連結另一個 Google 帳號。' : 'Google 登入沒有成功，請再試一次。'
    return showLogin(c, request, { error: message }, error.status === 409 ? 409 : 502)
  }
  return c.redirect(await finishLogin(c.env.DB, request, user), 303)
})
