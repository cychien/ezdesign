import { homedir } from 'node:os'
import { join } from 'node:path'

export const APP_NAME = 'ezdesign'
export const NPM_PACKAGE = '@cychien/ezdesign'
export const URL_PREFIX = '/__ezdesign'
const ENV_PREFIX = APP_NAME.toUpperCase()
export const DATA_DIR = process.env[`${ENV_PREFIX}_DATA_DIR`] ?? join(homedir(), `.${APP_NAME}`)
export const SESSIONS_DIR = join(DATA_DIR, 'sessions')
/** Where `(origin, project)` directories go once folded into project sessions:
 *  moved, never deleted, so a downgrade or a bad merge can be undone by hand. */
export const LEGACY_SESSIONS_DIR = join(DATA_DIR, 'sessions-legacy')
export const REGISTRY_FILE = join(DATA_DIR, 'daemon.json')
export const DAEMON_LOG = join(DATA_DIR, 'daemon.log')
/** Where a self-updating daemon installs the version it hands over to. */
export const VERSIONS_DIR = join(DATA_DIR, 'versions')
export const UPDATE_CHECK_FILE = join(DATA_DIR, 'update-check.json')
export const NO_UPDATE_CHECK_ENV = `${ENV_PREFIX}_NO_UPDATE_CHECK`
export const DESIGN_HARNESS_ENV = `${ENV_PREFIX}_DESIGN_HARNESS`

/** Unset, empty, `0` and `false` are off; anything else is on. */
export function envFlagOn(raw: string | undefined): boolean {
  return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false'
}

export const DEFAULT_CONTROL_PORT = 4400
const CONTROL_PORT_ENV = `${ENV_PREFIX}_CONTROL_PORT`
/** Only where the daemon looks for a free control port: daemons on different
 *  data dirs share a range without adopting each other. A set value is still a
 *  deliberate choice, so one that cannot make a bindable range is fatal rather
 *  than quietly swapped for the default. */
export function resolveControlPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONTROL_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1024 || port > 65_525) {
    throw new Error(
      `${CONTROL_PORT_ENV} must be an integer between 1024 and 65525, got ${JSON.stringify(raw)}`,
    )
  }
  return port
}

/** Ten consecutive ports starting at the resolved start. Resolved on call, not
 *  at import: this module is a dependency of the published `@cychien/ezdesign/vite`
 *  entry point, which must never read - let alone fail on - this variable. */
export function controlPortRange(): { start: number; end: number } {
  const start = resolveControlPort(process.env[CONTROL_PORT_ENV])
  return { start, end: start + 9 }
}

/** Surfaces a bad value at the command the user just ran, instead of leaving it
 *  to a detached daemon whose message only reaches the log file. */
export function assertControlPortEnv(): void {
  controlPortRange()
}

/** Per-file cap on a pasted attachment. A retina screenshot runs 2-5 MB, so this
 *  clears the case the feature exists for while keeping a stray video out.
 *  Mirrored in `src/client/attach.ts`, which cannot import from this module. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** How long an attachment nothing references survives the sweep. Long enough
 *  that a composer left open across a daemon restart still resolves its ids. */
export const ATTACHMENT_GRACE_MS = 24 * 60 * 60_000

/** How long one answer from the npm registry is trusted before asking again.
 *  A daemon lives as long as a review does, so this is the delay between a
 *  release and the shell offering it. */
export const UPDATE_CHECK_TTL_MS = 4 * 60 * 60_000

export const POLL_TIMEOUT_MS = 50_000
/** Consecutive connection failures a `poll` rides out before giving up. Covers a
 *  daemon restart, which the CLI survives by re-resolving the session port. */
export const POLL_RETRIES = 5
export const IDLE_STOP_MS = 30 * 60_000
export const SOURCE_ATTR = 'data-ez-source'
