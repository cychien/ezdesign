/** The session api answers the shell, the proxied app it frames, the CLI and
 *  the agent - and no other page in the browser.
 *
 *  A cross-origin page cannot read the api's answers, but a "simple" request (a
 *  bodiless POST, a form post) is still sent and still acts - `/end`,
 *  `/acp/cancel`, `/acp/answer`. Any website the user has open could do that,
 *  and so could an agent-written canvas frame one host away.
 *
 *  Browsers say where a request comes from (`Sec-Fetch-Site`, `Origin`); the
 *  CLI's and the agent's Node fetches say neither and pass, gated by the version
 *  header and their tokens as before. */

import type { RequestHandler } from 'express'

/** Mounted first on the api router. `sessionOrigin` (`http://127.0.0.1:<port>`)
 *  is read per request: the port is only known once bound. */
export function refuseCrossSite(sessionOrigin: () => string): RequestHandler {
  return (req, res, next) => {
    // `localhost:<port>` against `127.0.0.1:<port>` is cross-site; another
    // session on `127.0.0.1` is same-site. Neither may act here.
    const site = req.get('sec-fetch-site')
    const origin = req.get('origin')
    if (site === 'cross-site' || site === 'same-site' || (origin && origin !== sessionOrigin())) {
      res.status(403).json({ error: 'cross-site request refused' })
      return
    }
    next()
  }
}
