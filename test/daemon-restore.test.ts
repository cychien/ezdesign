import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, PKG_VERSION, sessionKey, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
after(() => world.dispose())

// Nothing listens here; the proxy is never exercised, only the session machinery.
const TARGET = 'http://127.0.0.1:9/'

/** One project per test: the project is the session, so tests sharing one would
 *  share a review. */
function project(name: string): string {
  const dir = join(world.dataDir, 'projects', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function findPort(controlPort: number, dir: string): Promise<number> {
  const found = await world.control(controlPort, `/control/sessions/find?project=${encodeURIComponent(dir)}`)
  assert.equal(found.status, 200)
  return ((await found.json()) as { port: number }).port
}

const AGENT_RESTART = project('agent-restart')

interface State {
  version: string
  agentOnline: boolean
  acp?: { agent: string; state: string }
  conversation: { role: string; text: string }[]
}

async function acpIdle(port: number): Promise<State> {
  return waitFor(async () => {
    const s = (await world.state(port)) as unknown as State
    return s.acp?.state === 'idle' ? s : null
  }, 'the ACP agent to go idle')
}

test('a restarted daemon brings the ACP agent back and says so in the thread', async () => {
  world.spawnDaemon()
  const first = await world.liveDaemon()
  const opened = await world.openSession(first.port, {
    url: TARGET,
    project: AGENT_RESTART,
    agent: FAKE_AGENT,
  })
  const before = await acpIdle(opened.port)
  assert.equal(before.version, PKG_VERSION)
  assert.equal(before.acp?.agent, FAKE_AGENT)

  // Something in the thread, so there is context whose loss is worth reporting.
  await world.sendFeedback(opened.port, 'make the hero bigger')

  assert.deepEqual(readdirSync(join(world.dataDir, 'sessions')), [sessionKey(AGENT_RESTART)])
  const persisted = JSON.parse(
    readFileSync(join(world.dataDir, 'sessions', sessionKey(AGENT_RESTART), 'session.json'), 'utf8'),
  ) as { agent?: string; port?: number }
  assert.equal(persisted.agent, FAKE_AGENT)

  await world.stopDaemon(first.port)
  world.spawnDaemon()
  const second = await world.liveDaemon()
  assert.notEqual(second.pid, first.pid)

  const port = await findPort(second.port, AGENT_RESTART)
  assert.equal(port, opened.port)

  const after = await acpIdle(port)
  assert.equal(after.agentOnline, true)
  const notice = after.conversation.find((e) => e.role === 'system' && /開啟新 session/.test(e.text))
  assert.ok(notice, 'the thread tells the user the agent came back without its context')
})

test('ending the session drops the agent, so a restore does not resurrect it', async () => {
  const live = await world.liveDaemon()
  const port = await findPort(live.port, AGENT_RESTART)
  const res = await fetch(`http://127.0.0.1:${port}/__ezdesign/api/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'user' }),
  })
  assert.equal(res.status, 200)

  const persisted = JSON.parse(
    readFileSync(join(world.dataDir, 'sessions', sessionKey(AGENT_RESTART), 'session.json'), 'utf8'),
  ) as { agent?: string; state: string }
  assert.equal(persisted.state, 'ended')
  assert.equal(persisted.agent, undefined)
})

test('a disconnected agent stays disconnected through a restart, until a shell connects one', async () => {
  const live = await world.liveDaemon()
  const dir = project('disconnect')
  const opened = await world.openSession(live.port, { url: 'http://127.0.0.1:13/', project: dir, agent: FAKE_AGENT })
  await acpIdle(opened.port)
  const api = `http://127.0.0.1:${opened.port}/__ezdesign/api`
  const post = (path: string, body: unknown = {}) =>
    fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  assert.equal((await post('/acp/disconnect')).status, 200)
  const disconnected = (await world.state(opened.port)) as unknown as State
  assert.equal(disconnected.acp, undefined)
  assert.equal(disconnected.agentOnline, false)
  const persisted = JSON.parse(readFileSync(join(world.dataDir, 'sessions', sessionKey(dir), 'session.json'), 'utf8')) as {
    agent?: string
    state: string
  }
  assert.deepEqual([persisted.state, persisted.agent], ['active', undefined])

  await world.stopDaemon(live.port)
  world.spawnDaemon()
  const next = await world.liveDaemon()
  const port = await findPort(next.port, dir)
  const restored = (await world.state(port)) as unknown as State
  assert.equal(restored.acp, undefined, 'a restore does not reconnect it')

  const nextApi = `http://127.0.0.1:${port}/__ezdesign/api`
  const connect = (id: string) =>
    fetch(`${nextApi}/acp/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
  assert.equal((await connect('nobody')).status, 400, 'only a known agent, by id')
})

test('a session whose last port is taken comes back on another one, not on none', async () => {
  const live = await world.liveDaemon()
  const origin = 'http://127.0.0.1:10'
  const dir = project('taken-port')
  const opened = await world.openSession(live.port, { url: `${origin}/`, project: dir })
  await world.stopDaemon(live.port)

  const squatter = createServer().listen(opened.port, '127.0.0.1')
  await new Promise((r) => squatter.once('listening', r))
  try {
    world.spawnDaemon()
    const next = await world.liveDaemon()
    const port = await findPort(next.port, dir)
    assert.notEqual(port, opened.port)
    const state = await world.state(port)
    assert.equal(state.app, origin)
  } finally {
    squatter.close()
  }
})

test('the update endpoint takes only the JSON requests the shell makes', async () => {
  const live = await world.liveDaemon()
  const { port } = await world.openSession(live.port, {
    url: 'http://127.0.0.1:11/',
    project: project('update'),
  })
  const url = `http://127.0.0.1:${port}/__ezdesign/api/update`
  const formPost = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '',
  })
  assert.equal(formPost.status, 415)
  const shellPost = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(shellPost.status, 409, 'nothing to update in a test world, but the request got through')
})

test('the restart notice is not repeated, and an empty thread never gets one', async () => {
  const origin = 'http://127.0.0.1:12'
  const live = await world.liveDaemon()
  const opened = await world.openSession(live.port, {
    url: `${origin}/`,
    project: project('notice'),
    agent: FAKE_AGENT,
  })

  const notices = async (port: number) => {
    const s = (await world.state(port)) as unknown as State
    return s.conversation.filter((e) => e.role === 'system' && /開啟新 session/.test(e.text)).length
  }

  // Nothing has been said on this session, so the first restart has no context
  // to report the loss of.
  await world.stopDaemon(live.port)
  world.spawnDaemon()
  let daemon = await world.liveDaemon()
  await acpIdle(opened.port)
  assert.equal(await notices(opened.port), 0)

  // Something in the thread, then two restarts back to back: the loss is real
  // once, and the second restart reports nothing new.
  await world.sendFeedback(opened.port, 'x')

  for (let i = 0; i < 2; i++) {
    await world.stopDaemon(daemon.port)
    world.spawnDaemon()
    daemon = await world.liveDaemon()
    await acpIdle(opened.port)
  }
  assert.equal(await notices(opened.port), 1)
})

// Before the agent was persisted and restored, an ACP child was only ever
// spawned from a CLI running inside the project, so a missing cwd was
// unreachable. On restore it is not: `spawn` reports it asynchronously with no
// `exit` event, and an unhandled 'error' would take the daemon - and every other
// session with it - down at startup.
test('a restored session whose project is gone reports a dead agent, not a dead daemon', async () => {
  const live = await world.liveDaemon()
  const gone = mkdtempSync(join(tmpdir(), 'ezdesign-vanishing-'))
  const origin = 'http://127.0.0.1:13'
  const opened = await world.openSession(live.port, {
    url: `${origin}/`,
    project: gone,
    agent: FAKE_AGENT,
  })
  await acpIdle(opened.port)

  await world.stopDaemon(live.port)
  rmSync(gone, { recursive: true, force: true })
  world.spawnDaemon()
  const next = await world.liveDaemon()

  // The other session on this daemon is still served, which is the point.
  const others = await world.control(next.port, '/control/sessions')
  assert.equal(others.status, 200)
  assert.ok(((await others.json()) as unknown[]).length > 1)

  const port = await findPort(next.port, gone)
  const state = await waitFor(async () => {
    const s = (await world.state(port)) as unknown as State & { acp?: { error?: string } }
    return s.acp?.state === 'exited' ? s : null
  }, 'the agent to report that it could not start')
  assert.match(state.acp?.error ?? '', /could not start|exited/)
  assert.equal(state.agentOnline, false)
})

// The daemon went down with a round mid-turn. No turn survives that, so the
// round comes back closed - and the one that had nothing yet does not come back
// on the strip at all.
test('an explore mid-turn when the daemon went down is over when the session returns', async () => {
  const origin = 'http://127.0.0.1:16'
  const live = await world.liveDaemon()
  const exploring = project('explore')
  const opened = await world.openSession(live.port, {
    url: `${origin}/`,
    project: exploring,
    agent: FAKE_AGENT,
  })
  await acpIdle(opened.port)

  const dir = sessionKey(exploring)
  const round = (id: string, variants: unknown[]) => ({
    id,
    chatId: 'c',
    label: id,
    anchor: { text: id },
    status: 'generating',
    variants,
    selected: null,
    startedAt: Date.now(),
  })
  writeFileSync(
    join(world.dataDir, 'sessions', dir, 'explores.json'),
    JSON.stringify([
      round('bare', []),
      round('partial', [{ id: 'v1', name: 'v', html: '<i/>', createdAt: Date.now() }]),
    ]),
  )

  await world.stopDaemon(live.port)
  world.spawnDaemon()
  const second = await world.liveDaemon()
  const port = await findPort(second.port, exploring)
  const state = (await world.state(port)) as { explores?: { id: string; status: string }[] }
  assert.deepEqual(
    state.explores?.map((e) => [e.id, e.status]),
    [['partial', 'cancelled']],
  )
})

// `npm run dev` opens without `--agent` and finds the restored session, which has one.
test('opening a session reports the agent it actually runs, flag or no flag', async () => {
  world.spawnDaemon()
  const first = await world.liveDaemon()
  const origin = 'http://127.0.0.1:14/'
  const PROJECT = project('report-agent')

  const withoutAgent = await world.openSession(first.port, { url: origin, project: PROJECT })
  assert.equal(withoutAgent.agent, undefined, 'nothing is running one yet')

  const opened = await world.openSession(first.port, {
    url: origin,
    project: PROJECT,
    agent: FAKE_AGENT,
  })
  assert.equal(opened.agent, FAKE_AGENT)
  await acpIdle(opened.port)

  const reopened = await world.openSession(first.port, { url: origin, project: PROJECT })
  assert.equal(
    reopened.agent,
    FAKE_AGENT,
    'the session still runs it; the call just did not say so',
  )

  await world.stopDaemon(first.port)
  world.spawnDaemon()
  const second = await world.liveDaemon()
  const restored = await world.openSession(second.port, { url: origin, project: PROJECT })
  assert.equal(restored.agent, FAKE_AGENT, 'and a restored one brings it back')
})

// No turn survives the daemon, so a round cut off holding nothing is closed on restore, and its pill,
// the way out of the branch, goes with it.
test('a restore into a branch whose round was cut off holding nothing opens on the main line', async () => {
  const world = await DaemonWorld.create()
  after(() => world.dispose())
  const acpIdle = (port: number) =>
    waitFor(async () => {
      const s = (await world.state(port)) as unknown as State
      return s.acp?.state === 'idle' ? s : null
    }, 'the ACP agent to go idle')
  world.spawnDaemon()
  const live = await world.liveDaemon()
  const origin = 'http://127.0.0.1:15/'
  const opened = await world.openSession(live.port, {
    url: origin,
    project: world.dataDir,
    agent: FAKE_AGENT,
  })
  await acpIdle(opened.port)
  const chats = async () =>
    ((await world.state(opened.port)) as unknown as { chats: { id: string; current: boolean }[] })
      .chats
  const main = (await chats()).find((c) => c.current)!.id
  const res = await fetch(`http://127.0.0.1:${opened.port}/__ezdesign/api/explore/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      anchor: { source: 'src/App.tsx:42', selector: 'main > button.cta', text: '免費試用' },
      capture: { html: '<button class="cta">免費試用</button>', parentWidth: 320 },
      direction: 'NOVARIANTS SLOW',
    }),
  })
  assert.equal(res.status, 200, await res.text())
  await waitFor(async () => {
    const s = (await world.state(opened.port)) as unknown as State
    return s.acp?.state === 'working'
  }, 'the explore turn')
  assert.notEqual((await chats()).find((c) => c.current)!.id, main, 'standing in the branch')

  await world.stopDaemon(live.port)
  world.spawnDaemon()
  await world.liveDaemon()
  const restored = await acpIdle(opened.port)
  assert.equal((await chats()).find((c) => c.current)!.id, main)
  assert.ok(restored.conversation.some((e) => e.role === 'system' && e.text.includes('已回到主對話')))
})
