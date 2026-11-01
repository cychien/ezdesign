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
/** The npm prefix ACP adapters are fetched under, apart from any project's. */
export const ACP_NPM_PREFIX = join(DATA_DIR, 'acp')
/** Where a self-updating daemon installs the version it hands over to. */
export const VERSIONS_DIR = join(DATA_DIR, 'versions')
export const UPDATE_CHECK_FILE = join(DATA_DIR, 'update-check.json')
export const libraryDir = (dataDir: string = DATA_DIR): string => join(dataDir, 'library')
const LIBRARY_HOME_ENV = `${ENV_PREFIX}_LIBRARY_HOME`
/** The data dir of the capture side: the library the shell shows, and the host
 *  and extension folder it installs. Set, it is outside the data dir: a dev
 *  daemon keeps its sessions apart from the real ones, but the extension saves
 *  into the real library, and that is the one worth browsing. */
export const libraryHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env[LIBRARY_HOME_ENV]?.trim() || DATA_DIR
export const nativeHostDir = (dataDir: string = DATA_DIR): string => join(dataDir, 'native-host')
export const installedExtensionDir = (dataDir: string = DATA_DIR): string => join(dataDir, 'extension')
export const NO_UPDATE_CHECK_ENV = `${ENV_PREFIX}_NO_UPDATE_CHECK`
export const DESIGN_HARNESS_ENV = `${ENV_PREFIX}_DESIGN_HARNESS`
export const API_URL_ENV = `${ENV_PREFIX}_API_URL`
export const NO_IDLE_STOP_ENV = `${ENV_PREFIX}_NO_IDLE_STOP`
export const PROJECTS_FILE = join(DATA_DIR, 'projects.json')
export const HOME_PATH = `${URL_PREFIX}/home`

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

/** The Fetch standard's "bad ports" (https://fetch.spec.whatwg.org/#bad-port).
 *  Node's fetch refuses them as a browser does, and the CLI, the agent and the
 *  dev scripts all reach the daemon over fetch, so it must never listen on one:
 *  4190 sits inside an otherwise ordinary range. */
export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
  110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/** Ten consecutive ports starting at the resolved start; `ports` is the ones a
 *  daemon may listen on. Resolved on call, not at import: this module is a
 *  dependency of the published `@cychien/ezdesign/vite` entry point, which must
 *  never read - let alone fail on - this variable. */
export function controlPortRange(): { start: number; end: number; ports: number[] } {
  const start = resolveControlPort(process.env[CONTROL_PORT_ENV])
  const ports = Array.from({ length: 10 }, (_, i) => start + i).filter((port) => !FETCH_BAD_PORTS.has(port))
  return { start, end: start + 9, ports }
}

/** Surfaces a bad value at the command the user just ran, instead of leaving it
 *  to a detached daemon whose message only reaches the log file. */
export function assertControlPortEnv(): void {
  controlPortRange()
}

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
export const IDLE_CHECK_MS = 60_000
/** How soon a shell's event stream retries a daemon that is gone. */
export const SHELL_RETRY_MS = 1000
/** How long a daemon that has taken a session's port back waits for the shells
 *  left open on it to reconnect: one retry, its connect, and slack. */
export const SHELL_RETURN_MS = 2000
export const SOURCE_ATTR = 'data-ez-source'
export const DEV_SERVER_READY_MS = 60_000
export const DEV_SERVER_PORT_SCAN_AFTER_MS = 3_000
export const DEV_SERVER_STOP_GRACE_MS = 3_000
export const DEV_SERVER_LOG_LINES = 2_000
