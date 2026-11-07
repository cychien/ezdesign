/** What a page and the extension address each other by. Imports nothing, so
 *  the shell, the extension and the capture wire can all bundle it. */

/** Fixed by the manifest's `key`. */
export const EXTENSION_ID = 'bgcgoejgebannhlbgfinbghahicahapb'

/** Sent by a page on `127.0.0.1` or `localhost`; the extension answers `{ version }`. */
export const EXTENSION_PING = 'ezdesign:ping'
