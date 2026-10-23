import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './env'
import { sessionFor } from './flow'
import { HttpError } from './http'

function bearer(header: string | undefined): string | null {
  const match = header && /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c.req.header('Authorization'))
  if (!token) throw new HttpError(401, 'sign-in required')
  const session = await sessionFor(c.env.DB, token)
  if (!session) throw new HttpError(401, 'session not recognised')
  c.set('user', session.user)
  c.set('sessionId', session.sessionId)
  await next()
}
