import type { RequestHandler } from 'express'
import { APP_NAME, NPM_PACKAGE } from './constants.js'
import { VERSION_HEADER } from './version-header.js'

export { VERSION_HEADER }

/** Reopening with @latest restarts the daemon on the CLI's version, so one hint
 *  covers a stale CLI and a stale daemon alike. */
export function versionMismatchBody(
  cliVersion: string | undefined,
  daemonVersion: string,
): { error: string; hint: string } {
  return {
    error: cliVersion
      ? `this ${APP_NAME} CLI is v${cliVersion} but the daemon is running v${daemonVersion}`
      : `this ${APP_NAME} CLI predates the running daemon (v${daemonVersion})`,
    hint: `re-run as \`npx -y ${NPM_PACKAGE}@latest <url>\` to bring both to the current version`,
  }
}

/** The wire protocol is only guaranteed between identical versions, so anything
 *  else — newer, older, or too old to send the header — is refused, not guessed at. */
export function versionGate(daemonVersion: string): RequestHandler {
  return (req, res, next) => {
    const cliVersion = req.get(VERSION_HEADER) || undefined
    if (cliVersion === daemonVersion) return next()
    res.status(409).json(versionMismatchBody(cliVersion, daemonVersion))
  }
}
