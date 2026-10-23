/** The shell's end of setting up the capture extension; see `capture-setup-wire.ts`.
 *  On the api router, behind `refuseCrossSite`: it writes into the browsers'
 *  native host folders. */

import { Router } from 'express'
import { CaptureInstallError, installCapture } from './capture-install/index.js'
import { readExtensionSeen } from './capture-seen.js'
import type { ExtensionInstallErrorWire, ExtensionInstallWire, ExtensionStatusWire } from './capture-setup-wire.js'

export function extensionApiRouter(placement: { distDir: string; version: string; dataDir: string }): Router {
  const router = Router()
  router.get('/extension/status', (_req, res) => {
    res.set('cache-control', 'no-store').json({ greeted: readExtensionSeen(placement.dataDir) } satisfies ExtensionStatusWire)
  })
  router.post('/extension/install', (_req, res, next) => {
    installCapture(placement).then(
      (report) =>
        res.json({
          extensionDir: report.extensionDir,
          browsers: report.targets.map((t) => t.browser?.name ?? t.userDataDir),
        } satisfies ExtensionInstallWire),
      (error: unknown) => {
        if (!(error instanceof CaptureInstallError)) return next(error)
        res.status(422).json({ error: error.message, problem: error.problem } satisfies ExtensionInstallErrorWire)
      },
    )
  })
  return router
}
