import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeAccountService {
  url: string
  requests: { route: string; form: URLSearchParams; authorization: string | undefined }[]
  answerToken: { status: number; body: unknown }
  close(): Promise<void>
}

export const ADA = { id: 'u_ada', email: 'ada@example.com' }

export async function fakeAccountService(): Promise<FakeAccountService> {
  const fake: FakeAccountService = {
    url: '',
    requests: [],
    answerToken: { status: 200, body: { access_token: 'eza_ada', token_type: 'Bearer', user: ADA } },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const route = `${req.method} ${new URL(req.url ?? '/', 'http://x').pathname}`
      fake.requests.push({ route, form: new URLSearchParams(raw), authorization: req.headers.authorization })
      const reply = (status: number, body: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (route === 'POST /token') return reply(fake.answerToken.status, fake.answerToken.body)
      if (route === 'POST /v1/logout') return reply(200, { ok: true })
      if (route === 'GET /v1/me') {
        return req.headers.authorization === 'Bearer eza_ada'
          ? reply(200, { user: ADA })
          : reply(401, { error: 'session not recognised' })
      }
      reply(404, { error: 'no route' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}
