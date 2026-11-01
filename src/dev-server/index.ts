import { readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DEV_SERVER_PORT_SCAN_AFTER_MS, DEV_SERVER_READY_MS, DEV_SERVER_STOP_GRACE_MS } from '../constants.js'
import { writeAtomic } from '../fs-atomic.js'
import { findExecutable } from '../login-env.js'
import { commandLine, detectDevCommand, missingTools, readProjectFacts, requiredTools, toolsForLine } from './detect.js'
import {
  type DevCommand,
  type DevServerEffect,
  type DevServerEvent,
  type DevServerMachine,
  INITIAL,
  type Initiator,
  type Resolution,
  step,
  toWire,
} from './lifecycle.js'
import { LogRing, ManagedProcess, listenerCwd, originAnswers } from './process.js'
import { projectRelativePath } from './proposal.js'
import type { DevCommandChoice, DevCommandWire, DevServerLogWire, DevServerSummaryWire, DevServerWire } from './wire.js'

export type { DevCommandChoice, DevServerLogWire, DevServerWire } from './wire.js'
export type { Initiator } from './lifecycle.js'
export { devServerApiRouter } from './routes.js'

export interface DevServerDeps {
  project: string
  dir: string
  userAttachedOrigin(): string | null
  heldElsewhere(origin: string): boolean
  attach(origin: string): void
  detachLeavingRecord(origin: string): void
  environmentReady(): Promise<unknown>
  onChange(): void
}

interface DevServerRecord {
  command?: { line: string; cwd: string; source: 'agent' | 'user'; decidedAt: number }
  resume?: { by: Initiator }
}

export type SaveCommandOutcome = 'started' | 'invalid-cwd' | 'invalid-line'

const CRASH_TAIL_LINES = 30
const PORT_SCAN_EVERY_MS = 1_000
const MAX_LINE = 500

export class DevServer {
  private machine: DevServerMachine = INITIAL
  private live: { runId: number; process: ManagedProcess } | null = null
  private readonly log = new LogRing()
  private startPreview: { command: DevCommandWire | null; runnable: boolean } | null = null

  constructor(private readonly deps: DevServerDeps) {}

  snapshot(): DevServerWire {
    const wire = toWire(this.machine.state)
    if ((wire.phase !== 'idle' && wire.phase !== 'stopped') || wire.command) return wire
    const { command } = this.upcoming()
    return command ? { ...wire, command } : wire
  }

  summary(): DevServerSummaryWire {
    const wire = toWire(this.machine.state)
    return 'origin' in wire ? { phase: wire.phase, origin: wire.origin } : { phase: wire.phase }
  }

  offersApp(): boolean {
    return this.machine.state.phase !== 'idle' || this.upcoming().runnable
  }

  logWire(): DevServerLogWire {
    return this.log.wire()
  }

  /** Idempotent: a no-op while starting, running or external; from anywhere
   *  else it reuses (D7), runs, or waits for a command. Never throws and never
   *  waits - progress arrives through `onChange`. */
  ensure(by: Initiator): void {
    this.dispatch({ type: 'ensure', now: Date.now(), by })
  }

  restart(by: Initiator): void {
    this.dispatch({ type: 'restart', now: Date.now(), by })
  }

  get managedBy(): Initiator | null {
    const state = this.machine.state
    return state.phase === 'starting' || state.phase === 'running' || state.phase === 'stopping' ? state.run.by : null
  }

  get external(): boolean {
    return this.machine.state.phase === 'external'
  }

  /** Resolves once the process group is gone (or at once when there was none).
   *  A server this daemon did not start is left alone (D7). */
  async stop(): Promise<void> {
    const live = this.live
    this.dispatch({ type: 'stop' })
    if (live?.process.running) await live.process.closed
  }

  saveCommandAndRun(choice: DevCommandChoice, by: Initiator): SaveCommandOutcome {
    const line = choice.line.trim()
    if (!line || line.length > MAX_LINE || /[\0\r\n]/.test(line)) return 'invalid-line'
    const cwd = projectRelativePath(this.deps.project, choice.cwd.trim() || '.')
    if (cwd === null) return 'invalid-cwd'
    this.writeRecord({ ...this.readRecord(), command: { line, cwd, source: 'user', decidedAt: Date.now() } })
    this.dispatch({ type: 'confirmed', now: Date.now(), by })
    return 'started'
  }

  forgetCommand(): void {
    const { command: _, ...rest } = this.readRecord()
    this.writeRecord(rest)
    this.startPreview = null
    this.dispatch({ type: 'command-forgotten' })
    this.deps.onChange()
  }

  pickOrigin(origin: string): boolean {
    const state = this.machine.state
    if (state.phase !== 'running' || !state.origins.includes(origin)) return false
    this.dispatch({ type: 'origin-picked', origin })
    return true
  }

  resume(): void {
    const resume = this.readRecord().resume
    if (resume) this.ensure(resume.by)
  }

  forgetResume(): void {
    const record = this.readRecord()
    if (!record.resume) return
    const { resume: _, ...rest } = record
    this.writeRecord(rest)
  }

  private dispatch(event: DevServerEvent): void {
    const { machine, effects, stateChanged } = step(this.machine, event)
    this.machine = machine
    if (stateChanged) this.startPreview = null
    for (const effect of effects) this.perform(effect)
    if (stateChanged) this.deps.onChange()
  }

  private dispatchAfterThisStep(event: DevServerEvent): void {
    queueMicrotask(() => this.dispatch(event))
  }

  private reportAlreadyExited(runId: number): void {
    this.dispatchAfterThisStep({ type: 'exited', runId, code: null, signal: null, tail: this.log.tail(CRASH_TAIL_LINES) })
  }

  private perform(effect: DevServerEffect): void {
    switch (effect.type) {
      case 'resolve': {
        const { attempt } = effect
        void this.resolve().then((resolution) => this.dispatch({ type: 'resolved', attempt, resolution, now: Date.now() }))
        return
      }
      case 'spawn': {
        const { run } = effect
        const runId = run.id
        this.log.clear()
        this.log.push([`$ ${run.command.line}`])
        const spec = { line: run.command.line, absoluteCwd: join(this.deps.project, run.command.cwd) }
        const managed = ManagedProcess.launch(spec, this.log, {
          output: (_, origins) => this.dispatch({ type: 'origins', runId, origins }),
          exited: (code, signal) => this.dispatch({ type: 'exited', runId, code, signal, tail: this.log.tail(CRASH_TAIL_LINES) }),
          spawnFailed: (error) => this.dispatch({ type: 'spawn-failed', runId, error }),
        })
        this.live = { runId, process: managed }
        return
      }
      case 'arm-timers': {
        const { runId } = effect
        setTimeout(() => this.dispatch({ type: 'scan-due', runId }), DEV_SERVER_PORT_SCAN_AFTER_MS).unref()
        setTimeout(
          () => this.dispatch({ type: 'ready-timeout', runId, tail: this.log.tail(CRASH_TAIL_LINES) }),
          DEV_SERVER_READY_MS,
        ).unref()
        return
      }
      case 'scan-ports': {
        const { runId } = effect
        const managed = this.live?.runId === runId ? this.live.process : null
        if (!managed) return
        void (async () => {
          for (const origin of await managed.listeningOrigins()) {
            if (await originAnswers(origin)) return this.dispatch({ type: 'port-found', runId, origin })
          }
          setTimeout(() => this.dispatch({ type: 'scan-due', runId }), PORT_SCAN_EVERY_MS).unref()
        })()
        return
      }
      case 'kill': {
        const { runId } = effect
        const managed = this.live?.runId === runId ? this.live.process : null
        if (managed?.running) void managed.stop(effect.grace ? DEV_SERVER_STOP_GRACE_MS : 0)
        else this.reportAlreadyExited(runId)
        return
      }
      case 'confirm-external': {
        const { runId, origin, tail } = effect
        void originAnswers(origin).then((alive) =>
          this.dispatch(alive ? { type: 'external-confirmed', runId, origin } : { type: 'external-gone', runId, tail }),
        )
        return
      }
      case 'attach':
        return this.deps.attach(effect.origin)
      case 'detach':
        return this.deps.detachLeavingRecord(effect.origin)
      case 'persist-resume': {
        const { resume: _, ...rest } = this.readRecord()
        this.writeRecord(effect.resume ? { ...rest, resume: effect.resume } : rest)
        return
      }
    }
  }

  private async resolve(): Promise<Resolution> {
    await this.deps.environmentReady()
    const recorded = this.deps.userAttachedOrigin()
    if (recorded && !this.deps.heldElsewhere(recorded) && (await originAnswers(recorded))) {
      const cwd = await listenerCwd(recorded)
      if (cwd.kind === 'unknown' || this.contains(cwd.path)) return { kind: 'external', origin: recorded }
    }
    const stored = this.storedCommand()
    let command: DevCommand
    let tools: string[]
    if (stored) {
      command = stored
      tools = toolsForLine(stored.line)
    } else {
      const detection = detectDevCommand(readProjectFacts(this.deps.project))
      if (detection.kind === 'undecided') {
        return { kind: 'undecided', reason: detection.reason, serverScripts: detection.serverScripts }
      }
      command = { line: commandLine(detection.command), cwd: '', source: 'detected' }
      tools = requiredTools(detection.command)
    }
    const missing = missingTools(tools, (binary) => findExecutable(binary, process.env.PATH))
    return missing.length ? { kind: 'blocked', command, missing } : { kind: 'run', command }
  }

  private contains(path: string): boolean {
    try {
      return projectRelativePath(this.deps.project, relative(realpathSync(this.deps.project), path)) !== null
    } catch {
      return false
    }
  }

  private upcoming(): { command: DevCommandWire | null; runnable: boolean } {
    if (this.startPreview) return this.startPreview
    const stored = this.storedCommand()
    if (stored) return (this.startPreview = { command: stored, runnable: true })
    const detection = detectDevCommand(readProjectFacts(this.deps.project))
    this.startPreview =
      detection.kind === 'command'
        ? { command: { line: commandLine(detection.command), cwd: '', source: 'detected' }, runnable: true }
        : { command: null, runnable: detection.reason === 'monorepo-root' || detection.serverScripts.length > 0 }
    return this.startPreview
  }

  private readRecord(): DevServerRecord {
    try {
      return JSON.parse(readFileSync(join(this.deps.dir, RECORD_FILE), 'utf8')) as DevServerRecord
    } catch {
      return {}
    }
  }

  private writeRecord(record: DevServerRecord): void {
    writeAtomic(join(this.deps.dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`)
  }

  private storedCommand(): DevCommand | null {
    const stored = this.readRecord().command
    return stored ? { line: stored.line, cwd: stored.cwd, source: stored.source } : null
  }
}

const RECORD_FILE = 'dev-server.json'
