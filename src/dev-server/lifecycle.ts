import type { CrashCause, DevCommandSource, DevServerWire, MissingToolWire, ProposalWire, UndecidedReason } from './wire.js'

export interface DevCommand {
  readonly line: string
  readonly cwd: string
  readonly source: DevCommandSource
}

export type Initiator = 'desktop' | 'browser' | 'cli'

export interface Run {
  readonly id: number
  readonly command: DevCommand
  readonly startedAt: number
  readonly by: Initiator
}

export type DevServerState =
  | { phase: 'idle' }
  | { phase: 'resolving'; since: number; by: Initiator; attempt: number }
  | { phase: 'starting'; since: number; run: Run }
  | { phase: 'running'; run: Run; origin: string; origins: readonly string[] }
  | { phase: 'stopping'; run: Run; then: { kind: 'stopped' } | { kind: 'restart'; by: Initiator; since: number } }
  | { phase: 'external'; origin: string }
  | { phase: 'needs-command'; reason: UndecidedReason; serverScripts: readonly string[]; proposal?: ProposalWire }
  | { phase: 'blocked'; command: DevCommand; missing: readonly MissingToolWire[] }
  | { phase: 'stopped'; command?: DevCommand }
  | {
      phase: 'crashed'
      command: DevCommand
      cause: CrashCause
      exitCode?: number
      signal?: string
      tail: readonly string[]
    }

export interface DevServerMachine {
  readonly state: DevServerState
  readonly lastAttempt: number
  readonly lastRunId: number
}

export const INITIAL: DevServerMachine = { state: { phase: 'idle' }, lastAttempt: 0, lastRunId: 0 }

export type Resolution =
  | { kind: 'external'; origin: string }
  | { kind: 'run'; command: DevCommand }
  | { kind: 'blocked'; command: DevCommand; missing: MissingToolWire[] }
  | { kind: 'undecided'; reason: UndecidedReason; serverScripts: string[] }

export type DevServerEvent =
  | { type: 'ensure'; now: number; by: Initiator }
  | { type: 'restart'; now: number; by: Initiator }
  | { type: 'stop' }
  | { type: 'resolved'; attempt: number; resolution: Resolution; now: number }
  | { type: 'origins'; runId: number; origins: readonly string[] }
  | { type: 'scan-due'; runId: number }
  | { type: 'port-found'; runId: number; origin: string }
  | { type: 'ready-timeout'; runId: number; tail: readonly string[] }
  | { type: 'exited'; runId: number; code: number | null; signal: string | null; tail: readonly string[] }
  /** After an exit 0 that printed an origin: Astro's "already running at ...".
   *  The origin answering means someone else's server is there to be used. */
  | { type: 'external-confirmed'; runId: number; origin: string }
  | { type: 'external-gone'; runId: number; tail: readonly string[] }
  | { type: 'spawn-failed'; runId: number; error: string }
  | { type: 'confirmed'; now: number; by: Initiator }
  | { type: 'command-forgotten' }
  | { type: 'ask-again' }
  | { type: 'proposal'; proposal: ProposalWire }
  | { type: 'origin-picked'; origin: string }

export type DevServerEffect =
  | { type: 'resolve'; attempt: number }
  | { type: 'spawn'; run: Run }
  | { type: 'kill'; runId: number; grace: boolean }
  | { type: 'arm-timers'; runId: number }
  | { type: 'scan-ports'; runId: number }
  | { type: 'confirm-external'; runId: number; origin: string; tail: readonly string[] }
  | { type: 'attach'; origin: string }
  | { type: 'detach'; origin: string }
  | { type: 'persist-resume'; resume: { by: Initiator } | null }
  | { type: 'ask-agent' }

export interface Step {
  machine: DevServerMachine
  effects: DevServerEffect[]
  stateChanged: boolean
}

export function step(machine: DevServerMachine, event: DevServerEvent): Step {
  const state = machine.state
  const to = (next: DevServerState, effects: DevServerEffect[] = [], counters: Partial<DevServerMachine> = {}): Step => ({
    machine: { ...machine, ...counters, state: next },
    effects,
    stateChanged: next !== state,
  })
  const same = (effects: DevServerEffect[] = []): Step => ({ machine, effects, stateChanged: false })
  const current = (runId: number) => liveRun(state)?.id === runId
  const resolveAfresh = (now: number, by: Initiator): Step => {
    const attempt = machine.lastAttempt + 1
    return to({ phase: 'resolving', since: now, by, attempt }, [{ type: 'resolve', attempt }], { lastAttempt: attempt })
  }
  const restartRun = (now: number, by: Initiator): Step => {
    if (state.phase === 'stopping') return to({ ...state, then: { kind: 'restart', by, since: now } })
    const run = liveRun(state)!
    return to({ phase: 'stopping', run, then: { kind: 'restart', by, since: now } }, [
      { type: 'kill', runId: run.id, grace: true },
      ...detachShown(state),
    ])
  }
  const crash = (run: Run, cause: CrashCause, tail: readonly string[], exit: { code?: number | null; signal?: string | null } = {}) =>
    to(
      {
        phase: 'crashed',
        command: run.command,
        cause,
        ...(exit.code !== undefined && exit.code !== null ? { exitCode: exit.code } : {}),
        ...(exit.signal ? { signal: exit.signal } : {}),
        tail,
      },
      [...detachShown(state), NO_RESUME],
    )

  switch (event.type) {
    case 'ensure':
      return RESTARTABLE.has(state.phase) ? resolveAfresh(event.now, event.by) : same()

    case 'restart':
      if (liveRun(state)) return restartRun(event.now, event.by)
      return RESTARTABLE.has(state.phase) ? resolveAfresh(event.now, event.by) : same()

    case 'confirmed':
      return liveRun(state) ? restartRun(event.now, event.by) : resolveAfresh(event.now, event.by)

    case 'stop': {
      if (state.phase === 'stopping') return to({ ...state, then: { kind: 'stopped' } }, [NO_RESUME])
      const run = liveRun(state)
      if (run) {
        return to({ phase: 'stopping', run, then: { kind: 'stopped' } }, [
          { type: 'kill', runId: run.id, grace: true },
          ...detachShown(state),
          NO_RESUME,
        ])
      }
      if (state.phase === 'resolving' || state.phase === 'needs-command') return to({ phase: 'stopped' }, [NO_RESUME])
      if (state.phase === 'blocked') return to({ phase: 'stopped', command: state.command }, [NO_RESUME])
      return same()
    }

    case 'resolved': {
      if (state.phase !== 'resolving' || state.attempt !== event.attempt) return same()
      const r = event.resolution
      switch (r.kind) {
        case 'run': {
          const run: Run = { id: machine.lastRunId + 1, command: r.command, startedAt: event.now, by: state.by }
          return to(
            { phase: 'starting', since: state.since, run },
            [
              { type: 'spawn', run },
              { type: 'arm-timers', runId: run.id },
              { type: 'persist-resume', resume: { by: state.by } },
            ],
            { lastRunId: run.id },
          )
        }
        case 'external':
          return to({ phase: 'external', origin: r.origin }, [{ type: 'attach', origin: r.origin }])
        case 'blocked':
          return to({ phase: 'blocked', command: r.command, missing: r.missing })
        case 'undecided':
          return to({ phase: 'needs-command', reason: r.reason, serverScripts: r.serverScripts }, [{ type: 'ask-agent' }])
      }
      return same()
    }

    case 'origins': {
      if (!current(event.runId) || !event.origins.length) return same()
      if (state.phase === 'starting') {
        const origin = event.origins[0]!
        return to({ phase: 'running', run: state.run, origin, origins: event.origins }, [{ type: 'attach', origin }])
      }
      if (state.phase === 'running' && event.origins.length > state.origins.length) {
        return to({ ...state, origins: event.origins })
      }
      return same()
    }

    case 'scan-due':
      return state.phase === 'starting' && current(event.runId) ? same([{ type: 'scan-ports', runId: event.runId }]) : same()

    case 'port-found':
      if (state.phase !== 'starting' || !current(event.runId)) return same()
      return to({ phase: 'running', run: state.run, origin: event.origin, origins: [event.origin] }, [
        { type: 'attach', origin: event.origin },
      ])

    case 'ready-timeout': {
      if (state.phase !== 'starting' || !current(event.runId)) return same()
      const crashed = crash(state.run, 'no-url', event.tail)
      return { ...crashed, effects: [{ type: 'kill', runId: event.runId, grace: false }, ...crashed.effects] }
    }

    case 'exited': {
      if (!current(event.runId)) return same()
      if (state.phase === 'stopping') {
        return state.then.kind === 'stopped'
          ? to({ phase: 'stopped', command: state.run.command })
          : resolveAfresh(state.then.since, state.then.by)
      }
      if (state.phase === 'running' && event.code === 0) {
        return same([{ type: 'confirm-external', runId: event.runId, origin: state.origin, tail: event.tail }])
      }
      return crash(liveRun(state)!, 'exited', event.tail, { code: event.code, signal: event.signal })
    }

    case 'external-confirmed':
      if (state.phase !== 'running' || !current(event.runId)) return same()
      return to({ phase: 'external', origin: event.origin }, [{ type: 'attach', origin: event.origin }, NO_RESUME])

    case 'external-gone':
      if (state.phase !== 'running' || !current(event.runId)) return same()
      return crash(state.run, 'exited', event.tail, { code: 0 })

    case 'spawn-failed':
      if (state.phase !== 'starting' || !current(event.runId)) return same()
      return crash(state.run, 'spawn', [event.error])

    case 'ask-again':
      if (state.phase !== 'needs-command' || state.proposal?.state === 'asking') return same()
      return to({ phase: 'needs-command', reason: state.reason, serverScripts: state.serverScripts }, [{ type: 'ask-agent' }])

    case 'proposal':
      return state.phase === 'needs-command' ? to({ ...state, proposal: event.proposal }) : same()

    case 'command-forgotten':
      return state.phase === 'blocked' || state.phase === 'crashed' || state.phase === 'stopped'
        ? to({ phase: 'stopped' })
        : same()

    case 'origin-picked':
      if (state.phase !== 'running' || state.origin === event.origin || !state.origins.includes(event.origin)) return same()
      return to({ ...state, origin: event.origin }, [{ type: 'attach', origin: event.origin }])
  }
}

const NO_RESUME: DevServerEffect = { type: 'persist-resume', resume: null }

const RESTARTABLE: ReadonlySet<DevServerState['phase']> = new Set(['idle', 'stopped', 'crashed', 'blocked'])

function liveRun(state: DevServerState): Run | null {
  return state.phase === 'starting' || state.phase === 'running' || state.phase === 'stopping' ? state.run : null
}

function detachShown(state: DevServerState): DevServerEffect[] {
  return state.phase === 'running' ? [{ type: 'detach', origin: state.origin }] : []
}

const commandWire = (command: DevCommand) => ({ line: command.line, cwd: command.cwd, source: command.source })

export function toWire(state: DevServerState): DevServerWire {
  switch (state.phase) {
    case 'idle':
      return { phase: 'idle' }
    case 'resolving':
      return { phase: 'starting', since: state.since }
    case 'starting':
      return { phase: 'starting', command: commandWire(state.run.command), since: state.since }
    case 'running':
      return {
        phase: 'running',
        command: commandWire(state.run.command),
        origin: state.origin,
        origins: [...state.origins],
        since: state.run.startedAt,
      }
    case 'stopping':
      return state.then.kind === 'restart'
        ? { phase: 'starting', command: commandWire(state.run.command), since: state.then.since }
        : { phase: 'stopped', command: commandWire(state.run.command) }
    case 'external':
      return { phase: 'external', origin: state.origin }
    case 'needs-command':
      return {
        phase: 'needs-command',
        reason: state.reason,
        serverScripts: [...state.serverScripts],
        ...(state.proposal ? { proposal: state.proposal } : {}),
      }
    case 'blocked':
      return { phase: 'blocked', command: commandWire(state.command), missing: [...state.missing] }
    case 'stopped':
      return { phase: 'stopped', ...(state.command ? { command: commandWire(state.command) } : {}) }
    case 'crashed':
      return {
        phase: 'crashed',
        command: commandWire(state.command),
        cause: state.cause,
        ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
        ...(state.signal ? { signal: state.signal } : {}),
        tail: [...state.tail],
      }
  }
}
