import { Hono } from 'hono'
import { requireUser } from '../auth'
import type { AppEnv } from '../env'
import { CLIENT_ID, createSession, redeemCode, revokeSession, userById } from '../flow'
import { HttpError } from '../http'

export const apiRoutes = new Hono<AppEnv>()

const field = (body: Record<string, unknown>, name: string) => {
  const value = body[name]
  return typeof value === 'string' && value !== '' ? value : null
}

apiRoutes.post('/token', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, unknown>
  if (field(body, 'grant_type') !== 'authorization_code') throw new HttpError(400, 'unsupported_grant_type')
  if (field(body, 'client_id') !== CLIENT_ID) throw new HttpError(401, 'invalid_client')
  const code = field(body, 'code')
  const verifier = field(body, 'code_verifier')
  const redirectUri = field(body, 'redirect_uri')
  if (!code || !verifier || !redirectUri) throw new HttpError(400, 'invalid_request')

  const userId = await redeemCode(c.env.DB, { code, verifier, redirectUri })
  const user = userId && (await userById(c.env.DB, userId))
  if (!user) throw new HttpError(400, 'invalid_grant')
  c.header('cache-control', 'no-store')
  return c.json({ access_token: await createSession(c.env.DB, user.id), token_type: 'Bearer', user })
})

apiRoutes.get('/v1/me', requireUser, (c) => c.json({ user: c.get('user') }))

apiRoutes.post('/v1/logout', requireUser, async (c) => {
  await revokeSession(c.env.DB, c.get('sessionId'))
  return c.json({ ok: true })
})
