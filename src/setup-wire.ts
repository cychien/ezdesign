/** What the shell's install menu shows. The daemon pushes it to every shell as
 *  the named event `setup`, in the first flush and on every change, so an
 *  install or a removal shows without the menu asking. Types and constants
 *  only, so the shell bundles it. */

import type { MacAppWire } from './mac-app-wire.js'

export const SSE_SETUP = 'setup'

export interface ExtensionPresenceWire {
  installed: boolean
  /** The browsers whose profiles list it, enabled. Empty while installed is
   *  known only from a greeting the browsers have not written down yet. */
  installedIn: string[]
}

export interface SetupWire {
  extension: ExtensionPresenceWire
  macApp: MacAppWire
}

export interface SetupEventWire {
  type: typeof SSE_SETUP
  setup: SetupWire
}
