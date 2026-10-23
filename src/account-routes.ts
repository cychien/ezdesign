import { type RequestHandler, Router } from 'express'
import { type Account, AccountError } from './account.js'
import { brandMarkSvg } from './brand.js'

export function accountApiRouter(host: { account: Account; callbackUrl: () => string }): Router {
  const router = Router()
  router.get('/account/login', (_req, res) => {
    res.set('cache-control', 'no-store').redirect(303, host.account.authorizeUrl(host.callbackUrl()))
  })
  router.post('/account/logout', async (_req, res) => {
    await host.account.signOut()
    res.json({ ok: true })
  })
  return router
}

export function crossSiteAccountCallback(account: Account): RequestHandler {
  return async (req, res) => {
    const { state, code } = req.query
    const send = (status: number, page: CallbackPage) =>
      res.status(status).set('cache-control', 'no-store').type('html').send(callbackHtml(page))
    if (typeof state !== 'string' || typeof code !== 'string') {
      return send(400, { title: '登入沒有完成', text: '這個連結少了登入資訊，請回到 ezdesign 重新登入。' })
    }
    try {
      const user = await account.complete(state, code)
      send(200, { title: '已登入 ezdesign', text: `以 ${user.email} 登入。可以關掉這個分頁，回到 ezdesign 繼續。`, close: true })
    } catch (error) {
      if (!(error instanceof AccountError)) throw error
      const text =
        error.problem === 'unknown-login'
          ? '這個登入已經失效，請回到 ezdesign 重新登入。'
          : error.problem === 'unreachable'
            ? '連不上 ezdesign 帳號服務，請檢查網路後回到 ezdesign 重新登入。'
            : '帳號服務沒有接受這次登入，請回到 ezdesign 重新登入。'
      send(error.problem === 'unknown-login' ? 400 : 502, { title: '登入沒有完成', text })
    }
  }
}

interface CallbackPage {
  title: string
  text: string
  close?: true
}

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

function callbackHtml(page: CallbackPage): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title)}</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px 16px;
    box-sizing: border-box;
    background: #faf9f6;
    color: #171717;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 360px; text-align: center; }
  svg { width: 32px; height: 32px; }
  h1 { margin: 16px 0 6px; font-size: 18px; font-weight: 600; }
  p { margin: 0; color: #676767; }
</style>
</head>
<body>
<main>
${brandMarkSvg()}
<h1>${escape(page.title)}</h1>
<p>${escape(page.text)}</p>
</main>
${page.close ? '<script>window.close()</script>' : ''}
</body>
</html>`
}
