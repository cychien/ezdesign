import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
const PREFERENCES = join(world.dataDir, 'preferences.json')
const useAgent = (command: string) => writeFileSync(PREFERENCES, JSON.stringify({ lastAgent: command }))
useAgent(FAKE_AGENT)
world.spawnDaemon()
const daemon = await world.liveDaemon()
after(() => world.dispose())

interface Proposal {
  state: string
  id?: string
  line?: string
  cwd?: string
  reason?: string
  error?: string
}
interface DevServer {
  phase: string
  proposal?: Proposal
  command?: { line: string; source: string }
}

const SERVER = `
import { createServer } from 'node:http'
const server = createServer((_req, res) => res.end('hello'))
server.listen(0, '127.0.0.1', () => console.log('  Local:   http://localhost:' + server.address().port + '/'))
`

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ezdesign-proposal-project-')))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts: { 'dev:web': 'node server.mjs', build: 'true' } }))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  writeFileSync(join(dir, 'server.mjs'), SERVER)
  return dir
}

const api = (port: number, path: string, body: unknown = {}) =>
  fetch(`http://127.0.0.1:${port}/__ezdesign/api/dev-server/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'browser', ...(body as object) }),
  })

const devServer = async (port: number) => ((await world.state(port)) as { devServer: DevServer }).devServer
const until = (port: number, ok: (s: DevServer) => boolean, what: string) =>
  waitFor(async () => {
    const s = await devServer(port)
    return ok(s) ? s : null
  }, what)

function storedCommand(dir: string): { line: string; source: string } | undefined {
  const sessions = join(world.dataDir, 'sessions')
  for (const key of readdirSync(sessions)) {
    const session = JSON.parse(readFileSync(join(sessions, key, 'session.json'), 'utf8')) as { project: string }
    if (session.project !== dir) continue
    try {
      return (JSON.parse(readFileSync(join(sessions, key, 'dev-server.json'), 'utf8')) as { command?: { line: string; source: string } }).command
    } catch {
      return undefined
    }
  }
  return undefined
}

test('the agent proposes, read-only; nothing runs before the user does', async () => {
  const dir = project()
  const { port } = await world.openSession(daemon.port, { project: dir })
  await api(port, 'start')
  const proposed = await until(port, (s) => s.proposal?.state === 'proposed', 'a proposal')
  assert.equal(proposed.phase, 'needs-command')
  assert.equal(proposed.proposal?.line, 'npm run dev:web')
  assert.equal(proposed.proposal?.cwd, '')
  assert.equal(proposed.proposal?.reason, 'dev:web serves the site; Bash was cancelled', 'every permission it asked for was declined')
  assert.equal(storedCommand(dir), undefined, 'a proposal is not stored')

  assert.equal((await api(port, 'command', { line: proposed.proposal!.line, cwd: '', proposalId: proposed.proposal!.id })).status, 202)
  const running = await until(port, (s) => s.phase === 'running', 'the confirmed command to run')
  assert.deepEqual(running.command, { line: 'npm run dev:web', cwd: '', source: 'agent' })
  assert.deepEqual(storedCommand(dir)?.source, 'agent')

  await api(port, 'stop')
  await api(port, 'start')
  const again = await until(port, (s) => s.phase === 'running', 'the saved command to be reused')
  assert.equal(again.command?.source, 'agent')
  await api(port, 'stop')
})

test('an edited proposal is the user’s own command', async () => {
  const dir = project()
  const { port } = await world.openSession(daemon.port, { project: dir })
  await api(port, 'start')
  const proposed = await until(port, (s) => s.proposal?.state === 'proposed', 'a proposal')
  await api(port, 'command', { line: 'node server.mjs', cwd: '', proposalId: proposed.proposal!.id })
  await until(port, (s) => s.phase === 'running', 'the edited command to run')
  assert.equal(storedCommand(dir)?.source, 'user')
  await api(port, 'stop')
})

test('no web app, a malformed answer and a missing agent each say so, and asking again works', async () => {
  for (const [agent, state] of [
    [`EZ_FAKE_PROPOSAL='{"command": null, "reason": "a CLI tool"}' ${FAKE_AGENT}`, 'none-found'],
    [`EZ_FAKE_PROPOSAL='not json' ${FAKE_AGENT}`, 'failed'],
    ['ezdesign-no-such-agent', 'failed'],
  ] as const) {
    useAgent(agent)
    const { port } = await world.openSession(daemon.port, { project: project() })
    await api(port, 'start')
    const answered = await until(port, (s) => s.proposal?.state === state, `${state} from ${agent}`)
    assert.equal(answered.phase, 'needs-command')
  }
  useAgent(FAKE_AGENT)
  const { port } = await world.openSession(daemon.port, { project: project() })
  writeFileSync(PREFERENCES, JSON.stringify({ lastAgent: 'ezdesign-no-such-agent' }))
  await api(port, 'start')
  await until(port, (s) => s.proposal?.state === 'failed', 'a failure')
  useAgent(FAKE_AGENT)
  assert.equal((await api(port, 'propose')).status, 202)
  await until(port, (s) => s.proposal?.state === 'proposed', 'a proposal on the second ask')
})
