/** How the shell sets up the capture extension, so no user needs a terminal:
 *  the daemon serving the shell already runs on their machine. Types only, so
 *  the shell bundles it.
 *
 *      GET  /extension/status  -> ExtensionStatusWire
 *      POST /extension/install -> ExtensionInstallWire
 *
 *  Install errors are `ExtensionInstallErrorWire` (422). */

export interface ExtensionStatusWire {
  /** The extension the native host last greeted, and when. It outlives the
   *  extension being removed, so only a greeting after an install proves it. */
  greeted: { version: string; at: number } | null
}

export type CaptureInstallProblem = 'node-too-old' | 'no-browser' | 'unsupported-platform' | 'not-built' | 'bad-record'

export interface ExtensionInstallErrorWire {
  /** The CLI's words, in English. */
  error: string
  problem: CaptureInstallProblem
}

export interface ExtensionInstallWire {
  /** The folder to load in chrome://extensions. */
  extensionDir: string
  /** The browsers whose native host folder now names it. */
  browsers: string[]
}
