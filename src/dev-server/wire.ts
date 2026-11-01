export type DevCommandSource = 'detected' | 'agent' | 'user'

export interface DevCommandWire {
  /** One shell line, run by `sh -c` in `cwd`. */
  line: string
  /** Relative to the project root; `''` is the root itself. */
  cwd: string
  source: DevCommandSource
}

export type UndecidedReason =
  | 'no-package-json'
  | 'no-script'
  | 'monorepo-root'

export type InstallPart = { text: string } | { command: string }

export interface MissingToolWire {
  tool: string
  install: InstallPart[]
}

export type CrashCause =
  | 'exited'
  /** Nothing local was printed and no port opened within `DEV_SERVER_READY_MS`. */
  | 'no-url'
  /** The shell could not be started at all. */
  | 'spawn'

export type DevServerWire =
  /** Nothing asked for yet in this daemon's life; `command` is what a start
   *  would run, when that is already known. */
  | { phase: 'idle'; command?: DevCommandWire }
  | { phase: 'needs-command'; reason: UndecidedReason; serverScripts: string[]; proposal?: ProposalWire }
  | { phase: 'blocked'; command: DevCommandWire; missing: MissingToolWire[] }
  /** Spawned and not yet reachable - or, with no `command` yet, still deciding
   *  what to run (probing a recorded origin, reading `package.json`). */
  | { phase: 'starting'; command?: DevCommandWire; since: number }
  | {
      phase: 'running'
      command: DevCommandWire
      /** The one on the App tab. */
      origin: string
      /** Every distinct local origin it printed, first first. The App tab offers
       *  the others. */
      origins: string[]
      since: number
    }
  /** A dev server this daemon did not start - the session's recorded origin
   *  answered, or the command reported one already running and exited. Used,
   *  never stopped. */
  | { phase: 'external'; origin: string }
  | { phase: 'stopped'; command?: DevCommandWire }
  | {
      phase: 'crashed'
      command: DevCommandWire
      cause: CrashCause
      exitCode?: number
      signal?: string
      tail: string[]
    }

export interface DevServerSummaryWire {
  phase: DevServerWire['phase']
  origin?: string
}

/** `GET /dev-server/log`. */
export interface DevServerLogWire {
  lines: string[]
  /** Lines dropped from the front since the run started. */
  dropped: number
}

export type ProposalWire =
  | { state: 'asking'; agent: string }
  | { state: 'proposed'; id: string; agent: string; line: string; cwd: string; reason: string }
  | { state: 'none-found'; agent: string; reason: string }
  | { state: 'failed'; agent: string; error: string }

/** `POST /dev-server/command`: the user's own command for the project. */
export interface DevCommandChoice {
  line: string
  cwd: string
  proposalId?: string
}

/** `POST /dev-server/origin`: the App tab's pick among several printed URLs. */
export interface DevOriginChoice {
  origin: string
}
