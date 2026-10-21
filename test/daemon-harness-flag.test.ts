import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const FLAG = 'EZDESIGN_DESIGN_HARNESS'
const ON = '增強設計 (the design harness) is on for this turn.'
const OFF = '增強設計 (the design harness) is off for this turn.'
const DISABLED = { error: 'the design harness is disabled' }
const SETUP_DROPPED = '已關閉增強設計，尚未開始的建立已取消'

interface State {
  acp?: { state?: string }
  conversation?: { role: string; text: string; batchId?: string }[]
}

const worlds: DaemonWorld[] = []
after(() => Promise.all(worlds.map((w) => w.dispose())))

let nextPort = 9700

async function newWorld(flag: boolean): Promise<DaemonWorld> {
  const world = await DaemonWorld.create()
  worlds.push(world)
  if (flag) world.env[FLAG] = '1'
  else delete world.env[FLAG]
  return world
}

function project(world: DaemonWorld, files: ('product' | 'design')[]): string {
  const dir = mkdtempSync(join(world.dataDir, 'project-'))
  if (files.includes('product')) writeFileSync(join(dir, 'PRODUCT.md'), '# Product\n\n## Users\n\nPeople.\n')
  if (files.includes('design')) writeFileSync(join(dir, 'DESIGN.md'), '---\nname: Fixture\n---\n')
  return dir
}

function preferences(world: DaemonWorld): string {
  return join(world.dataDir, 'preferences.json')
}

function rememberHarness(world: DaemonWorld, projectDir: string): string {
  const body = JSON.stringify({ designHarness: { [projectDir]: true }, designEffort: { [projectDir]: 'high' } })
  writeFileSync(preferences(world), body)
  return body
}

const state = (world: DaemonWorld, port: number) => world.state(port) as Promise<State>

const idle = (world: DaemonWorld, port: number) =>
  waitFor(async () => (await state(world, port)).acp?.state === 'idle', 'the agent to be idle')

async function openReady(world: DaemonWorld, projectDir: string): Promise<{ port: number; control: number }> {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: `http://localhost:${nextPort++}`,
    project: projectDir,
    agent: FAKE_AGENT,
  })
  await idle(world, port)
  return { port, control }
}

const api = (port: number, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/__ezdesign/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const reportsIn = (s: State) =>
  s.conversation?.filter((e) => e.role === 'agent' && e.text.includes('"prompts"')) ?? []

/** Every prompt the agent process in front of this session has received. */
async function prompts(world: DaemonWorld, port: number): Promise<string[]> {
  const before = reportsIn(await state(world, port)).length
  await api(port, '/send', { note: 'REPORT' })
  const reports = await waitFor(async () => {
    const found = reportsIn(await state(world, port))
    return found.length > before ? found : null
  }, 'the agent to report')
  const report = JSON.parse(reports.at(-1)!.text) as { prompts: { text: string }[] }
  return report.prompts.map((p) => p.text)
}

test('C2 without the flag a project that remembers the harness is reviewed as if it never had it', async () => {
  const world = await newWorld(false)
  const dir = project(world, ['product', 'design'])
  rememberHarness(world, dir)
  const { port } = await openReady(world, dir)

  await world.sendFeedback(port, '把按鈕改藍')

  const s = await state(world, port)
  assert.equal(s.acp?.state, 'idle')
  assert.ok(!('designHarness' in s), 'no designHarness key in the state')
  assert.ok(!('designEffort' in s), 'no designEffort key in the state')
  const [prompt] = await prompts(world, port)
  assert.ok(prompt!.includes('sent this feedback batch'), 'the batch reached the agent')
  assert.ok(prompt!.includes('"comment": "把按鈕改藍"'), 'with its item')
  for (const word of ['增強設計', 'PRODUCT.md', 'DESIGN.md', 'reference/make.md']) {
    assert.ok(!prompt!.includes(word), `the prompt never says ${word}`)
  }
})

test('C3 without the flag the switch endpoints answer 404 and leave the preferences alone', async () => {
  const world = await newWorld(false)
  const dir = project(world, ['product', 'design'])
  const before = rememberHarness(world, dir)
  const { port } = await openReady(world, dir)
  assert.equal(readFileSync(preferences(world), 'utf8'), before)
  assert.equal(JSON.parse(before).designHarness[dir], true, 'there is a remembered switch to protect')

  for (const [path, body] of [
    ['/harness', { on: true }],
    ['/harness', { on: false }],
    ['/harness/effort', { effort: 'low' }],
  ] as const) {
    const res = await api(port, path, body)
    assert.equal(res.status, 404, `${path} ${JSON.stringify(body)}`)
    assert.deepEqual(await res.json(), DISABLED)
  }
  assert.equal(readFileSync(preferences(world), 'utf8'), before, 'preferences.json is byte-identical')
})

test('C4 a chat that had the harness on is told it is off when the daemon restarts without the flag', async () => {
  const world = await newWorld(true)
  const dir = project(world, ['product', 'design'])
  const { port, control } = await openReady(world, dir)
  const on = await api(port, '/harness', { on: true })
  assert.equal(on.status, 200, await on.text())
  await world.sendFeedback(port, '第一批')
  const [first] = await prompts(world, port)
  assert.ok(first!.includes(ON), 'the flag-on run exposed the chat to the harness')

  await world.stopDaemon(control)
  delete world.env[FLAG]
  world.spawnDaemon()
  const next = await world.liveDaemon()
  const found = await world.control(next.port, `/control/sessions/find?project=${encodeURIComponent(dir)}`)
  const { port: restored } = (await found.json()) as { port: number }
  await idle(world, restored)

  await world.sendFeedback(restored, '第二批')
  const [second] = await prompts(world, restored)
  assert.ok(second!.includes('"comment": "第二批"'), 'the second batch reached the agent')
  assert.ok(second!.includes(OFF), 'and the agent is told the harness is off')
  assert.ok(!second!.includes(ON))
})

test('C5 without the flag a setup that never started is settled instead of delivered', async () => {
  const world = await newWorld(false)
  const dir = project(world, ['product'])
  const origin = 'http://localhost:9790'
  // A pre-project `(origin, project)` directory, which the daemon migrates.
  const legacyKey = createHash('sha1').update(`${origin}\n${dir}`).digest('hex').slice(0, 12)
  const sessionDir = join(world.dataDir, 'sessions', legacyKey)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, 'session.json'),
    JSON.stringify({
      targetOrigin: origin,
      project: dir,
      state: 'active',
      createdAt: Date.now(),
      agent: FAKE_AGENT,
      designHarness: true,
    }),
  )
  writeFileSync(
    join(sessionDir, 'outbox.json'),
    JSON.stringify([{ batchId: 'setup-1', items: [], note: null, setup: true, sentAt: Date.now() }]),
  )
  writeFileSync(
    join(sessionDir, 'conversation.json'),
    JSON.stringify([
      { role: 'user', text: '啟用增強設計，建立 DESIGN.md', ts: Date.now(), batchId: 'setup-1' },
    ]),
  )

  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const found = await world.control(control, `/control/sessions/find?project=${encodeURIComponent(dir)}`)
  const { port } = (await found.json()) as { port: number }
  await idle(world, port)

  const s = await state(world, port)
  const dropped = s.conversation
    ?.filter((e) => e.text === SETUP_DROPPED)
    .map(({ role, text, batchId }) => ({ role, text, batchId }))
  assert.deepEqual(dropped, [{ role: 'system', text: SETUP_DROPPED, batchId: 'setup-1' }])
  assert.ok(s.conversation?.some((e) => e.role === 'user' && e.text === '啟用增強設計，建立 DESIGN.md'))
  assert.ok(!existsSync(join(dir, 'DESIGN.md')), 'nothing built DESIGN.md')
  await world.sendFeedback(port, '另一批')
  const all = await prompts(world, port)
  assert.ok(all.some((p) => p.includes('"comment": "另一批"')), 'the agent does take a feedback batch')
  assert.ok(!all.some((p) => p.includes('switched on the design harness')), 'no setup prompt was sent')
})
