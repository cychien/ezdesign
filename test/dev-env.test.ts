import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'ezdesign-dev-env-')))
const daemons: ChildProcess[] = []
after(() => {
  for (const d of daemons) d.kill('SIGKILL')
  rmSync(base, { recursive: true, force: true })
})

const FAKE_DAEMON = `import { createServer } from 'node:http'
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, service: 'ezdesign', pid: process.pid }))
})
server.listen(0, '127.0.0.1', () => process.send(server.address().port))
`

/** As much of a checkout as the dev scripts look at: their own dev-env.mjs, and
 *  a dist/cli.mjs whose `__daemon` answers health the way the real one does. */
async function checkout(name: string) {
  const root = join(base, name)
  for (const dir of ['scripts', 'dist', '.dev']) mkdirSync(join(root, dir), { recursive: true })
  const devEnv = join(root, 'scripts/dev-env.mjs')
  copyFileSync(fileURLToPath(new URL('../scripts/dev-env.mjs', import.meta.url)), devEnv)
  writeFileSync(join(root, 'dist/cli.mjs'), FAKE_DAEMON)
  return { root, env: await import(pathToFileURL(devEnv).href) }
}

async function startDaemon(root: string): Promise<{ port: number; pid: number }> {
  const child = spawn(process.execPath, [join(root, 'dist/cli.mjs'), '__daemon'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  daemons.push(child)
  const [port] = (await once(child, 'message')) as [number]
  return { port, pid: child.pid! }
}

const register = (root: string, daemon: { port: number; pid: number }) =>
  writeFileSync(join(root, '.dev/daemon.json'), JSON.stringify({ ...daemon, startedAt: 0 }))

// `repo` is a path prefix of `repo-b`, the way a worktree sits beside its checkout.
const a = await checkout('repo')
const b = await checkout('repo-b')

test('a checkout recognises its own dev daemon', async () => {
  const own = await startDaemon(a.root)
  register(a.root, own)
  assert.deepEqual(await a.env.ownDaemon(), own)
})

// What a daemon that adopts one it finds in its range leaves behind.
test("never claims another checkout's daemon, even when its registry names it", async () => {
  const foreign = await startDaemon(b.root)
  register(a.root, foreign)
  assert.deepEqual(await a.env.registeredDaemon(), foreign)
  assert.equal(await a.env.ownDaemon(), null)
})

test('moves off a control block that something else holds', async () => {
  const preferred: number = a.env.devControlPort()
  const squatter = createServer()
  await new Promise<void>((resolve) => {
    squatter.once('error', () => resolve())
    squatter.listen(preferred + 3, '127.0.0.1', resolve)
  })
  try {
    const { controlPort } = await a.env.claimDevPorts()
    assert.notEqual(controlPort, preferred)
    assert.ok(
      controlPort >= 4100 && controlPort <= 4190 && controlPort % 10 === 0,
      String(controlPort),
    )
  } finally {
    squatter.close()
  }
})
