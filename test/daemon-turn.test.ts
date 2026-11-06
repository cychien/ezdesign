import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
after(() => world.dispose())

/** Every entry the thread holds, in order. */
async function thread(port: number): Promise<{ role: string; text: string }[]> {
  const state = (await world.state(port)) as { conversation?: { role: string; text: string }[] }
  return state.conversation ?? []
}

// The thread draws a pulse for a review that is waiting, and waiting is not the
// same as a turn running: a batch can sit with nothing started on it - behind a
// session that is still opening, or with no agent there to take it at all. The
// shell cannot see the outbox, so the wire has to tell the two apart, or the
// pulse either lies about plain navigation or misses the send it exists for.
test('feedback no turn has started yet is reported as waiting', async () => {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: 'http://localhost:9996',
    project: world.dataDir,
  })
  const before = (await world.state(port)) as { agentQueued?: true; agentBusy?: boolean }
  assert.equal(before.agentQueued, undefined, 'nothing has been asked of it yet')

  await fetch(`http://127.0.0.1:${port}/__ezdesign/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'waiting on nobody' }),
  })

  const after = (await world.state(port)) as { agentQueued?: true; agentBusy?: boolean }
  assert.equal(after.agentQueued, true, 'a batch nothing has started is not reported as waiting')
  assert.equal(after.agentBusy, false, 'and no turn has begun')
})

// A turn that ran to its own end without a word wrote nothing at all: the user's
// message sat there with no reply and no explanation, which is indistinguishable
// from a turn still running. There is no other way to tell waiting from finished,
// so the thread has to say which it is.
test('a turn that ends without saying anything still says so', async () => {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: 'http://localhost:9997',
    project: world.dataDir,
    agent: FAKE_AGENT,
  })
  await waitFor(async () => {
    const s = (await world.state(port)) as { acp?: { state?: string } }
    return s.acp?.state === 'idle'
  }, 'the agent to be ready')

  await fetch(`http://127.0.0.1:${port}/__ezdesign/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'SILENT' }),
  })

  const note = await waitFor(
    async () => (await thread(port)).find((e) => e.role === 'system' && e.text.includes('沒有回覆')),
    'the thread to account for the silent turn',
  )
  assert.match(note.text, /這一輪結束了/)

  // And the turn is over as far as everything else is concerned - a note that
  // arrived while the agent was still held busy would be worse than none.
  const idle = (await world.state(port)) as { acp?: { state?: string } }
  assert.equal(idle.acp?.state, 'idle')
})

interface Entry {
  role: string
  text: string
  batchId?: string
}

interface TurnState {
  acp?: { state?: string; feed?: unknown[] }
  conversation: Entry[]
  activeBatchId?: string
  agentQueued?: true
}

async function turnState(port: number): Promise<TurnState> {
  return (await world.state(port)) as unknown as TurnState
}

async function send(port: number, note: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/__ezdesign/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  })
  return ((await res.json()) as { batchId: string }).batchId
}

/** A project of its own, so one test's turn - parked, if it failed - is not the
 *  next one's. */
async function openWithAgent(url: string, agent: string): Promise<number> {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const project = mkdtempSync(join(world.dataDir, 'project-'))
  const { port } = await world.openSession(control, { url, project, agent })
  await waitFor(
    async () => (await turnState(port)).acp?.state === 'idle',
    'the agent to be ready',
  )
  return port
}

const turnUnderWay = (port: number) =>
  waitFor(async () => {
    const s = await turnState(port)
    return s.acp?.state === 'working' && !!s.acp.feed?.length
  }, 'the turn to be under way')

// What a user sends while the agent is working is meant to turn it around, not
// to wait behind the work it may be overriding. It goes into the turn, and the
// thread still reads as question, answer, question, answer: what the agent said
// before it took the second batch answers the first.
test('a batch sent mid-turn goes into that turn, and the reply splits where it went in', async () => {
  const port = await openWithAgent('http://localhost:9994', FAKE_AGENT)
  const first = await send(port, 'first SLOW')
  await turnUnderWay(port)
  const second = await send(port, 'second SLOW')

  const moved = await waitFor(async () => {
    const s = await turnState(port)
    return s.activeBatchId === second && !!s.acp?.feed?.length && s
  }, 'the turn to move on to the second batch')
  assert.equal(moved.acp?.state, 'working', 'the same turn carries on')
  const early = moved.conversation.filter((e) => e.role === 'agent')
  assert.deepEqual(
    early.map((e) => e.batchId),
    [first],
    'what was said before the steer answers the first batch',
  )
  assert.match(early[0]!.text, /"note": "first SLOW"/)

  const third = await send(port, 'third')
  const done = await waitFor(async () => {
    const s = await turnState(port)
    return s.acp?.state === 'idle' && s
  }, 'the turn to end')
  const replies = done.conversation.filter((e) => e.role !== 'user')
  assert.deepEqual(
    replies.map((e) => [e.role, e.batchId]),
    [
      ['agent', first],
      ['agent', second],
      ['agent', third],
    ],
  )
  assert.match(replies[1]!.text, /steered:While you were working[\s\S]*"note": "second SLOW"/)
  assert.match(replies[2]!.text, /steered:While you were working[\s\S]*"note": "third"/)
  assert.equal(done.agentQueued, undefined, 'nothing is left waiting: every batch was answered')
})

// A turn that has said nothing yet when the next batch goes in leaves nothing
// under the first question: the reply under the next one covers both.
test('a batch steered past a silent one leaves the reply to cover both', async () => {
  const port = await openWithAgent('http://localhost:9993', FAKE_AGENT)
  const first = await send(port, 'QUIET SLOW')
  await waitFor(
    async () => (await turnState(port)).acp?.state === 'working',
    'the turn to start',
  )
  const second = await send(port, 'second')
  const done = await waitFor(async () => {
    const s = await turnState(port)
    return s.acp?.state === 'idle' && s.conversation.some((e) => e.role === 'agent') && s
  }, 'the turn to end')
  assert.deepEqual(
    done.conversation.filter((e) => e.role !== 'user').map((e) => [e.role, e.batchId]),
    [['agent', second]],
  )
  assert.ok(!done.conversation.some((e) => e.role !== 'user' && e.batchId === first))
})

// An agent without the extension, or a turn of another kind, keeps the old
// order: the batch waits for the turn to end and goes as a turn of its own.
test('an agent that cannot be steered answers the next batch after the turn', async () => {
  const port = await openWithAgent('http://localhost:9992', `EZ_FAKE_NO_STEER=1 ${FAKE_AGENT}`)
  const first = await send(port, 'first SLOW')
  await turnUnderWay(port)
  const second = await send(port, 'second')
  await new Promise((r) => setTimeout(r, 300))
  const waiting = await turnState(port)
  assert.equal(waiting.activeBatchId, first, 'the turn is still on the first batch')

  await fetch(`http://127.0.0.1:${port}/__ezdesign/api/acp/cancel`, { method: 'POST' })
  const done = await waitFor(async () => {
    const s = await turnState(port)
    return s.acp?.state === 'idle' && s.conversation.some((e) => e.batchId === second && e.role === 'agent') && s
  }, 'the second batch to get a turn of its own')
  const reply = done.conversation.find((e) => e.batchId === second && e.role === 'agent')!
  assert.doesNotMatch(reply.text, /steered/)
  assert.match(reply.text, /"note": "second"/)
})

// Two batches sent back to back: the second can reach the agent before the turn
// the first one started is under way, and be told there is nothing to steer. It
// is offered again rather than left for the end of a turn it was meant to change.
test('a batch sent on the heels of the one that started the turn still goes into it', async () => {
  const port = await openWithAgent('http://localhost:9991', FAKE_AGENT)
  const first = await send(port, 'first LATESTART STEER SLOW')
  const second = await send(port, 'second')
  const done = await waitFor(async () => {
    const s = await turnState(port)
    return s.acp?.state === 'idle' && s
  }, 'the turn to end')
  const replies = done.conversation.filter((e) => e.role !== 'user')
  assert.deepEqual(
    replies.map((e) => [e.role, e.batchId]),
    [
      ['agent', first],
      ['agent', second],
    ],
  )
  assert.match(replies[1]!.text, /steered:While you were working/)
})

// An agent that keeps refusing is not asked forever: the batch waits for the
// turn to end and goes as a turn of its own.
test('a turn that keeps refusing a steer answers the batch after it ends', async () => {
  const port = await openWithAgent('http://localhost:9990', FAKE_AGENT)
  const first = await send(port, 'first LATESTART 30000 SLOW')
  const second = await send(port, 'second')
  await new Promise((r) => setTimeout(r, 4000))
  await fetch(`http://127.0.0.1:${port}/__ezdesign/api/acp/cancel`, { method: 'POST' })
  const done = await waitFor(async () => {
    const s = await turnState(port)
    return s.acp?.state === 'idle' && s.conversation.some((e) => e.batchId === second && e.role === 'agent') && s
  }, 'the second batch to get a turn of its own')
  assert.ok(done.conversation.some((e) => e.batchId === first && e.text === '已中止'))
  const reply = done.conversation.find((e) => e.batchId === second && e.role === 'agent')!
  assert.doesNotMatch(reply.text, /steered/)
})

// A daemon that goes down mid-turn hands the turn's first batch out again when it
// comes back. A batch that had been steered into the lost turn is marked as
// handed out too, but the new turn never saw it: ending that turn must not
// settle it, or the user's message is answered by nobody.
test('a batch steered into a turn the daemon lost is answered after the restart', async () => {
  const port = await openWithAgent('http://localhost:9989', FAKE_AGENT)
  const first = await send(port, 'first SLOW')
  await turnUnderWay(port)
  const second = await send(port, 'second SLOW')
  await waitFor(async () => (await turnState(port)).activeBatchId === second, 'the steer to go in')

  await world.stopDaemon((await world.liveDaemon()).port)
  world.spawnDaemon()
  await world.liveDaemon()
  await waitFor(async () => (await turnState(port).catch(() => null))?.activeBatchId === first, 'the first batch to be handed out again')
  await fetch(`http://127.0.0.1:${port}/__ezdesign/api/acp/cancel`, { method: 'POST' })
  await waitFor(async () => (await turnState(port)).activeBatchId === second, 'the second batch to get a turn of its own')
  await fetch(`http://127.0.0.1:${port}/__ezdesign/api/acp/cancel`, { method: 'POST' })
  const done = await waitFor(async () => {
    const s = await turnState(port)
    return s.acp?.state === 'idle' && s
  }, 'the review to settle')
  assert.equal(done.agentQueued, undefined)
})
