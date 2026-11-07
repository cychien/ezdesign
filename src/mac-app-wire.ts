/** How the shell installs the Mac app. The daemon downloads and verifies the
 *  release itself: a copy that never passed through a browser carries no
 *  quarantine, so macOS opens it without the "unidentified developer" detour.
 *  Types only, so the shell bundles it.
 *
 *      GET  /mac-app         -> MacAppWire
 *      POST /mac-app/install -> MacAppWire, with the install under way
 *      POST /mac-app/open    -> 204, or 404 with nothing installed */

export type MacAppJobWire =
  | { phase: 'idle' }
  | { phase: 'downloading'; received: number; total: number | null }
  | { phase: 'installing' }
  | { phase: 'failed'; error: string }

export interface MacAppWire {
  /** The app is macOS only. */
  supported: boolean
  installed: { path: string; version: string } | null
  job: MacAppJobWire
  /** Where to download it by hand, should installing here fail. */
  releasesUrl: string
}
