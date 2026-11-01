import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type DevCommand,
  type DevServerEffect,
  type DevServerEvent,
  type DevServerMachine,
  INITIAL,
  step,
  toWire,
} from '../src/dev-server/lifecycle.js'

const VITE: DevCommand = { line: 'pnpm dev', cwd: '', source: 'detected' }
const ORIGIN = 'http://localhost:5173'

function run(events: DevServerEvent[], from: DevServerMachine = INITIAL) {
  let machine = from
  const effects: DevServerEffect[] = []
  for (const event of events) {
    const next = step(machine, event)
    machine = next.machine
    effects.push(...next.effects)
  }
  return { machine, effects, wire: toWire(machine.state) }
}

const started: DevServerEvent[] = [
  { type: 'ensure', now: 1, by: 'browser' },
  { type: 'resolved', attempt: 1, resolution: { kind: 'run', command: VITE }, now: 2 },
]
const RUN = 1

test('ensure resolves, spawns, and shows the first origin printed', () => {
  const { machine, effects, wire } = run([...started, { type: 'origins', runId: RUN, origins: [ORIGIN, 'http://localhost:5174'] }])
  assert.deepEqual(effects, [
    { type: 'resolve', attempt: 1 },
    { type: 'spawn', run: { id: RUN, command: VITE, startedAt: 2, by: 'browser' } },
    { type: 'arm-timers', runId: RUN },
    { type: 'persist-resume', resume: { by: 'browser' } },
    { type: 'attach', origin: ORIGIN },
  ])
  assert.deepEqual(wire, {
    phase: 'running',
    command: VITE,
    origin: ORIGIN,
    origins: [ORIGIN, 'http://localhost:5174'],
    since: 2,
  })
  assert.equal(machine.lastRunId, RUN)
  assert.equal(machine.lastAttempt, 1)
})

test('ensure is a no-op while starting, running or external', () => {
  const starting = run(started).machine
  assert.equal(step(starting, { type: 'ensure', now: 9, by: 'cli' }).stateChanged, false)
  const external = run([
    { type: 'ensure', now: 1, by: 'browser' },
    { type: 'resolved', attempt: 1, resolution: { kind: 'external', origin: ORIGIN }, now: 2 },
  ])
  assert.deepEqual(external.effects.at(-1), { type: 'attach', origin: ORIGIN })
  assert.deepEqual(step(external.machine, { type: 'ensure', now: 9, by: 'cli' }).effects, [])
})

test('a stop during resolve wins over the resolution that lands after it', () => {
  const { wire, effects } = run([
    { type: 'ensure', now: 1, by: 'browser' },
    { type: 'stop' },
    { type: 'resolved', attempt: 1, resolution: { kind: 'run', command: VITE }, now: 2 },
  ])
  assert.deepEqual(wire, { phase: 'stopped' })
  assert.equal(effects.some((e) => e.type === 'spawn'), false)
})

test('a resolution from an earlier attempt is dropped once a newer one runs', () => {
  const { wire, effects } = run([
    { type: 'ensure', now: 1, by: 'browser' },
    { type: 'stop' },
    { type: 'ensure', now: 3, by: 'browser' },
    { type: 'resolved', attempt: 1, resolution: { kind: 'external', origin: 'http://localhost:9999' }, now: 4 },
  ])
  assert.deepEqual(wire, { phase: 'starting', since: 3 })
  assert.equal(effects.some((e) => e.type === 'attach'), false)
})

test('stop kills with grace and detaches; the exit after it lands on stopped', () => {
  const running = run([...started, { type: 'origins', runId: RUN, origins: [ORIGIN] }]).machine
  const stopping = step(running, { type: 'stop' })
  assert.deepEqual(stopping.effects, [
    { type: 'kill', runId: RUN, grace: true },
    { type: 'detach', origin: ORIGIN },
    { type: 'persist-resume', resume: null },
  ])
  assert.deepEqual(toWire(stopping.machine.state), { phase: 'stopped', command: VITE })
  const second = step(stopping.machine, { type: 'stop' })
  assert.equal(second.effects.some((e) => e.type === 'kill'), false, 'a second stop sends no second kill')
  const exited = step(second.machine, { type: 'exited', runId: RUN, code: null, signal: 'SIGTERM', tail: [] })
  assert.deepEqual(toWire(exited.machine.state), { phase: 'stopped', command: VITE })
})

test('a restart waits for the old group to die before resolving again', () => {
  const running = run([...started, { type: 'origins', runId: RUN, origins: [ORIGIN] }]).machine
  const restarting = run(
    [
      { type: 'restart', now: 10, by: 'browser' },
      { type: 'origins', runId: RUN, origins: [ORIGIN, 'http://localhost:5174'] },
    ],
    running,
  )
  assert.deepEqual(restarting.wire, { phase: 'starting', command: VITE, since: 10 })
  assert.equal(restarting.effects.some((e) => e.type === 'resolve'), false)
  const after = step(restarting.machine, { type: 'exited', runId: RUN, code: null, signal: 'SIGTERM', tail: [] })
  assert.deepEqual(after.effects, [{ type: 'resolve', attempt: RUN + 1 }])
  assert.deepEqual(toWire(after.machine.state), { phase: 'starting', since: 10 })
})

test('a URL printed after the ready timeout is ignored', () => {
  const { wire, effects } = run([
    ...started,
    { type: 'ready-timeout', runId: RUN, tail: ['compiling...'] },
    { type: 'origins', runId: RUN, origins: [ORIGIN] },
    { type: 'exited', runId: RUN, code: null, signal: 'SIGKILL', tail: [] },
  ])
  assert.deepEqual(wire, { phase: 'crashed', command: VITE, cause: 'no-url', tail: ['compiling...'] })
  assert.deepEqual(effects.slice(-2), [
    { type: 'kill', runId: RUN, grace: false },
    { type: 'persist-resume', resume: null },
  ])
})

test('the port scan finds a server that printed nothing', () => {
  const { wire, effects } = run([
    ...started,
    { type: 'scan-due', runId: RUN },
    { type: 'port-found', runId: RUN, origin: 'http://localhost:8080' },
  ])
  assert.deepEqual(effects.slice(-2), [
    { type: 'scan-ports', runId: RUN },
    { type: 'attach', origin: 'http://localhost:8080' },
  ])
  assert.equal(wire.phase, 'running')
})

test('exit 0 after a URL: a server still answering there is someone else’s', () => {
  const printed = run([...started, { type: 'origins', runId: RUN, origins: [ORIGIN] }]).machine
  const exited = step(printed, { type: 'exited', runId: RUN, code: 0, signal: null, tail: ['already running'] })
  assert.deepEqual(exited.effects, [{ type: 'confirm-external', runId: RUN, origin: ORIGIN, tail: ['already running'] }])
  const alive = step(exited.machine, { type: 'external-confirmed', runId: RUN, origin: ORIGIN })
  assert.deepEqual(toWire(alive.machine.state), { phase: 'external', origin: ORIGIN })
  assert.deepEqual(alive.effects, [
    { type: 'attach', origin: ORIGIN },
    { type: 'persist-resume', resume: null },
  ])
  const dead = step(exited.machine, { type: 'external-gone', runId: RUN, tail: ['bye'] })
  assert.deepEqual(toWire(dead.machine.state), { phase: 'crashed', command: VITE, cause: 'exited', exitCode: 0, tail: ['bye'] })
  assert.deepEqual(dead.effects, [
    { type: 'detach', origin: ORIGIN },
    { type: 'persist-resume', resume: null },
  ])
})

test('a crash keeps the last lines and takes the origin off the App tab', () => {
  const { wire, effects } = run([
    ...started,
    { type: 'origins', runId: RUN, origins: [ORIGIN] },
    { type: 'exited', runId: RUN, code: 1, signal: null, tail: ['Error: boom'] },
  ])
  assert.deepEqual(wire, { phase: 'crashed', command: VITE, cause: 'exited', exitCode: 1, tail: ['Error: boom'] })
  assert.deepEqual(effects.slice(-2), [
    { type: 'detach', origin: ORIGIN },
    { type: 'persist-resume', resume: null },
  ])
})

test('restart from a crash starts over', () => {
  const crashed = run([...started, { type: 'exited', runId: RUN, code: 1, signal: null, tail: [] }]).machine
  const again = step(crashed, { type: 'restart', now: 20, by: 'browser' })
  assert.deepEqual(again.effects, [{ type: 'resolve', attempt: RUN + 1 }])
})

test('a spawn that fails is a crash with the error as its tail', () => {
  const { wire } = run([...started, { type: 'spawn-failed', runId: RUN, error: 'spawn ENOENT' }])
  assert.deepEqual(wire, { phase: 'crashed', command: VITE, cause: 'spawn', tail: ['spawn ENOENT'] })
})

test('an external server is never stopped here', () => {
  const external = run([
    { type: 'ensure', now: 1, by: 'browser' },
    { type: 'resolved', attempt: 1, resolution: { kind: 'external', origin: ORIGIN }, now: 2 },
  ]).machine
  const stopped = step(external, { type: 'stop' })
  assert.equal(stopped.stateChanged, false)
  assert.deepEqual(stopped.effects, [])
})

test('needs-command waits for the user; their command starts it', () => {
  const undecided = run([
    { type: 'ensure', now: 1, by: 'browser' },
    { type: 'resolved', attempt: 1, resolution: { kind: 'undecided', reason: 'no-script', serverScripts: ['dev:web'] }, now: 2 },
  ])
  assert.deepEqual(undecided.wire, { phase: 'needs-command', reason: 'no-script', serverScripts: ['dev:web'] })
  assert.equal(step(undecided.machine, { type: 'ensure', now: 3, by: 'browser' }).stateChanged, false)
  const confirmed = step(undecided.machine, { type: 'confirmed', now: 4, by: 'browser' })
  assert.deepEqual(confirmed.effects, [{ type: 'resolve', attempt: 2 }])
})

test('a confirmed command while running restarts onto it', () => {
  const running = run([...started, { type: 'origins', runId: RUN, origins: [ORIGIN] }]).machine
  const { effects, machine } = step(running, { type: 'confirmed', now: 5, by: 'browser' })
  assert.deepEqual(effects, [
    { type: 'kill', runId: RUN, grace: true },
    { type: 'detach', origin: ORIGIN },
  ])
  assert.equal(machine.state.phase, 'stopping')
})

test('the origin switch only offers what was printed', () => {
  const running = run([...started, { type: 'origins', runId: RUN, origins: [ORIGIN, 'http://localhost:5174'] }]).machine
  assert.equal(step(running, { type: 'origin-picked', origin: 'http://localhost:9000' }).stateChanged, false)
  const picked = step(running, { type: 'origin-picked', origin: 'http://localhost:5174' })
  assert.deepEqual(picked.effects, [{ type: 'attach', origin: 'http://localhost:5174' }])
  assert.equal((toWire(picked.machine.state) as { origin?: string }).origin, 'http://localhost:5174')
})

test('blocked carries what is missing', () => {
  const missing = [{ tool: 'pnpm', install: [{ text: '執行 ' }, { command: 'corepack enable pnpm' }] }]
  const { wire } = run([
    { type: 'ensure', now: 1, by: 'browser' },
    { type: 'resolved', attempt: 1, resolution: { kind: 'blocked', command: VITE, missing }, now: 2 },
  ])
  assert.deepEqual(wire, { phase: 'blocked', command: VITE, missing })
})

test('forgetting the stored command drops it from a card that showed it', () => {
  const missing = [{ tool: 'turbo', install: [{ text: '安裝 ' }, { command: 'turbo' }] }]
  const blocked = run([
    { type: 'ensure', now: 1, by: 'browser' },
    { type: 'resolved', attempt: 1, resolution: { kind: 'blocked', command: { line: 'turbo dev', cwd: '', source: 'user' }, missing }, now: 2 },
    { type: 'command-forgotten' },
  ])
  assert.deepEqual(blocked.wire, { phase: 'stopped' })
  const running = run([...started, { type: 'origins', runId: RUN, origins: [ORIGIN] }]).machine
  assert.equal(step(running, { type: 'command-forgotten' }).stateChanged, false, 'a live run keeps the command it runs')
})

test('an undecided project asks the agent; a second ask waits for the first', () => {
  const undecided = run([
    { type: 'ensure', now: 1, by: 'browser' },
    { type: 'resolved', attempt: 1, resolution: { kind: 'undecided', reason: 'no-script', serverScripts: [] }, now: 2 },
  ])
  assert.deepEqual(undecided.effects.at(-1), { type: 'ask-agent' })
  const asking = step(undecided.machine, { type: 'proposal', proposal: { state: 'asking', agent: 'claude' } }).machine
  assert.equal(step(asking, { type: 'ask-again' }).stateChanged, false)
  const failed = step(asking, { type: 'proposal', proposal: { state: 'failed', agent: 'claude', error: 'timeout' } })
  assert.deepEqual(toWire(failed.machine.state), {
    phase: 'needs-command',
    reason: 'no-script',
    serverScripts: [],
    proposal: { state: 'failed', agent: 'claude', error: 'timeout' },
  })
  assert.deepEqual(step(failed.machine, { type: 'ask-again' }).effects, [{ type: 'ask-agent' }])
})

test('a proposal that lands after the user moved on is dropped', () => {
  const stopped = run([
    { type: 'ensure', now: 1, by: 'browser' },
    { type: 'resolved', attempt: 1, resolution: { kind: 'undecided', reason: 'no-script', serverScripts: [] }, now: 2 },
    { type: 'stop' },
  ]).machine
  assert.equal(step(stopped, { type: 'proposal', proposal: { state: 'asking', agent: 'claude' } }).stateChanged, false)
})
