/** The dev-server proxy of one session, with a target that can be attached,
 *  changed and detached while the server is listening.
 *
 *  Both proxies are built once with a `router` that reads the current
 *  attachment per request. A request that arrives while nothing is attached is
 *  answered here instead of proxied: a top-level page load goes to the shell, a
 *  preview frame gets a note saying there is no app - never the shell inside
 *  its own stage - and anything else a 404.
 *
 *  Detaching, or attaching a different origin, destroys the upgraded sockets by
 *  hand: the shell tab holds the app's HMR websocket through here for as long
 *  as it is open, and `server.close` would wait on it forever. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Request, RequestHandler, Response } from 'express'
import {
  type RequestHandler as ProxyHandler,
  createProxyMiddleware,
  responseInterceptor,
} from 'http-proxy-middleware'
import { URL_PREFIX } from './constants.js'
import { isFrameHost } from './canvas/frame-document.js'
import { injectOverlay, wantsHtml } from './inject.js'
import type { AppAttachment, AttachedApp } from './store.js'

const NO_APP = `<!doctype html><meta charset="utf-8"><title>ezdesign</title>
<p>No dev server is attached to this review. Run <code>ezdesign &lt;url&gt;</code> in the project to attach one.</p>`

export const UNREACHABLE_HEADER = 'x-ezdesign-unreachable'

/** The app's server stopped answering. The page retries on its own and reloads
 *  once the server is back, so restarting it is all the user has to do. */
const unreachable = (origin: string) => `<!doctype html><meta charset="utf-8"><title>連不上 App</title>
<style>
  /* The shell's dev-server prompt, in its tokens' values: this page is served without the shell's CSS. */
  body { margin: 0; background: #faf9f6;
    color: #171717; font: 13.5px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', sans-serif; }
  main { display: grid; width: min(520px, calc(100% - 48px)); margin: max(48px, 12vh) auto 48px; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
  p { margin: 6px 0 18px; color: #676767; }
  code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
  button { justify-self: start; height: 32px; padding: 0 14px; border: 1px solid #171717; border-radius: 7px;
    background: #171717; color: #fff; box-shadow: inset 0 1px 0 0 rgb(255 255 255 / 0.14);
    font: 600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', sans-serif; cursor: pointer; }
  button:hover { opacity: 0.88; }
</style>
<main>
<h1>連不上 App</h1>
<p><code>${origin.replace(/^https?:\/\//, '')}</code> 沒有回應，dev server 可能停了。</p>
<button type="button" onclick="location.reload()">重新整理</button>
</main>
<script>
  setInterval(() => fetch(location.href, { method: 'HEAD', cache: 'no-store' })
    .then((r) => { if (!r.headers.has('${UNREACHABLE_HEADER}')) location.reload() }, () => {}), 1500)
</script>`

export class AppProxy {
  private current: AppAttachment = { kind: 'none' }
  private readonly upgraded = new Set<Socket>()
  private readonly htmlProxy: ProxyHandler<Request, Response>
  private readonly rawProxy: ProxyHandler<Request, Response>

  constructor(
    /** Where a page load goes while nothing is attached. */
    private readonly shellPath: string,
    /** Cookie capture, kept out of here: the proxy forwards, the runtime
     *  remembers. */
    private readonly onRequest: (req: IncomingMessage) => void,
  ) {
    const router = () => (this.current.kind === 'attached' ? this.current.origin : undefined)
    const error = (_err: Error, req: IncomingMessage, res: ServerResponse | Socket) => {
      if (!('writeHead' in res) || res.headersSent) return void res.end()
      const origin = this.current.kind === 'attached' ? this.current.origin : ''
      res.writeHead(502, { 'content-type': wantsHtml(req.headers.accept) ? 'text/html; charset=utf-8' : 'text/plain', [UNREACHABLE_HEADER]: '1' })
      res.end(wantsHtml(req.headers.accept) ? unreachable(origin) : '')
    }
    this.htmlProxy = createProxyMiddleware<Request, Response>({
      router,
      changeOrigin: true,
      selfHandleResponse: true,
      on: {
        error,
        proxyRes: responseInterceptor(async (buffer, proxyRes, _req, res) => {
          res.removeHeader('content-security-policy')
          res.removeHeader('x-frame-options')
          const type = String(proxyRes.headers['content-type'] ?? '')
          if (!type.includes('text/html')) return buffer
          return injectOverlay(buffer.toString('utf8'))
        }),
      },
    })
    this.rawProxy = createProxyMiddleware<Request, Response>({ router, changeOrigin: true, ws: true, on: { error } })
  }

  get attachment(): AppAttachment {
    return this.current
  }

  /** The same origin again only updates `attachedAt`; a different one drops
   *  the old target's upgraded sockets first. */
  attach(app: AttachedApp): void {
    if (this.current.kind === 'attached' && this.current.origin !== app.origin) {
      this.destroyUpgraded()
    }
    this.current = app
  }

  /** Idempotent. */
  detach(): void {
    this.destroyUpgraded()
    this.current = { kind: 'none' }
  }

  /** The catch-all mounted after the `/__ezdesign` router. */
  middleware(): RequestHandler {
    return (req, res, next) => {
      this.onRequest(req)
      if (this.current.kind === 'none') {
        const dest = req.headers['sec-fetch-dest']
        if (dest === 'document' && req.method === 'GET') return res.redirect(this.shellPath)
        // A preview the shell mounted before it learned there is no app: it is
        // about to be torn down, and a 404 would only be a console error.
        if (dest === 'iframe') return res.type('html').send(NO_APP)
        if (wantsHtml(req.headers.accept)) return res.status(404).type('html').send(NO_APP)
        return res.sendStatus(404)
      }
      return wantsHtml(req.headers.accept)
        ? this.htmlProxy(req, res, next)
        : this.rawProxy(req, res, next)
    }
  }

  /** `server.on('upgrade')`. Our own paths are never upgraded, nor anything on
   *  the frame host or while detached; the rest is tracked for `detach`. */
  upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (req.url?.startsWith(URL_PREFIX) || isFrameHost(req.headers.host) || this.current.kind === 'none') {
      socket.destroy()
      return
    }
    this.upgraded.add(socket)
    socket.once('close', () => this.upgraded.delete(socket))
    this.rawProxy.upgrade(req, socket, head)
  }

  private destroyUpgraded(): void {
    for (const socket of this.upgraded) socket.destroy()
    this.upgraded.clear()
  }
}
