import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message)
  }
}

export function onError(err: Error, c: Context) {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
  console.error('unhandled', err.stack ?? err.message)
  return c.json({ error: 'internal error' }, 500)
}

export function notFound(c: Context) {
  return c.json({ error: `no route for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404)
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}
