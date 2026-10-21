import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { PollResult } from '../src/protocol.js'
import { CLI_SRC, DaemonWorld, TSX, waitFor } from './helpers/daemon.js'

const world = await DaemonWorld.create()
after(() => world.dispose())

// The login prompt only appears on a terminal, and node has no pty of its own.
const PTY = `
import json, os, pty, select, sys, time
keys, cmd = sys.argv[1].encode().decode('unicode_escape'), sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
out, sent, deadline = b'', False, time.time() + 20
while time.time() < deadline:
    if not sent and b'token:' in out:
        os.write(fd, keys.encode())
        sent = True
    if select.select([fd], [], [], 0.05)[0]:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
_, status = os.waitpid(pid, 0)
print(json.dumps({
    'output': out.decode(errors='replace'),
    'signal': os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
    'code': os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
}))
`

function loginAtTerminal(keys: string, env: NodeJS.ProcessEnv) {
  const run = spawnSync(
    'python3',
    ['-c', PTY, keys, process.execPath, '--import', 'tsx', CLI_SRC, 'login'],
    { env, encoding: 'utf8' },
  )
  return JSON.parse(run.stdout) as { output: string; signal: number | null; code: number | null }
}

function loginEnv(): { dataDir: string; env: NodeJS.ProcessEnv } {
  const dataDir = mkdtempSync(join(tmpdir(), 'ezdesign-interrupt-'))
  return { dataDir, env: { ...process.env, EZDESIGN_DATA_DIR: dataDir, HOME: dataDir } }
}

test('Ctrl+C at the login prompt is an interrupt, not an error, and stores nothing', () => {
  const { dataDir, env } = loginEnv()
  const run = loginAtTerminal('half-typed\\x03', env)
  assert.equal(run.signal, 2, `ended by SIGINT, got ${JSON.stringify(run)}`)
  assert.doesNotMatch(run.output, /error/)
  assert.equal(existsSync(join(dataDir, 'credentials.json')), false)
})

test('Ctrl+D at the login prompt is no token given', () => {
  const { dataDir, env } = loginEnv()
  const run = loginAtTerminal('\\x04', env)
  assert.equal(run.code, 1)
  assert.match(run.output, /error: no token given/)
  assert.equal(existsSync(join(dataDir, 'credentials.json')), false)
})

// A poll the user interrupts leaves the daemon with no one on the other end:
// the shell must not keep showing an agent, nor hand it the next batch.
test('an interrupted poll is no longer a connected agent and is handed nothing', async () => {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const project = realpathSync(world.dataDir)
  const { port } = await world.openSession(control, {
    url: 'http://localhost:9995',
    project,
  })
  const poll = spawn(process.execPath, ['--import', TSX, CLI_SRC, 'poll'], {
    env: world.env,
    cwd: project,
    stdio: 'ignore',
  })
  await waitFor(async () => (await world.state(port)).agentOnline === true, 'the poll to connect')

  poll.kill('SIGINT')
  await new Promise((resolve) => poll.once('exit', resolve))
  await waitFor(async () => (await world.state(port)).agentOnline === false, 'the agent to go offline', 3000)

  await world.postFeedback(port, 'bigger heading')
  const state = (await world.state(port)) as {
    agentOnline: boolean
    agentBusy: boolean
    agentQueued?: true
  }
  assert.equal(state.agentOnline, false, 'the interrupted poll is not taken for an agent')
  assert.equal(state.agentBusy, false, 'no agent is working on it')
  assert.equal(state.agentQueued, true, 'it waits for the next poll')

  const polled = await world.run(['poll'], { cwd: project })
  assert.equal(polled.code, 0, polled.stderr)
  const next = JSON.parse(polled.stdout) as PollResult
  assert.ok(next.type === 'feedback', `the next poll is handed the batch, got ${next.type}`)
  assert.deepEqual(next.items.map((i) => i.comment), ['bigger heading'])
})
