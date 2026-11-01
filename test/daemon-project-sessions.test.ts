import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type Server, createServer, request } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, sessionKey, waitFor } from './helpers/daemon.js'

interface State {
  state: string
  app?: string
  agentProgress?: string
  annotations: { comment: string }[]
  conversation: { role: string; text: string }[]
  acp?: { state: string }
}

const worlds: DaemonWorld[] = []
const servers: Server[] = []
after(async () => {
  for (const server of servers) server.close()
  await Promise.all(worlds.map((w) => w.dispose()))
})

async function newWorld(): Promise<DaemonWorld> {
  const world = await DaemonWorld.create()
  worlds.push(world)
  // The CLI opens the shell in a browser; here it only records that it tried.
  const shims = join(world.dataDir, 'shims')
  mkdirSync(shims, { recursive: true })
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(shims, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(shims, name), 0o755)
  }
  world.env.PATH = `${shims}:${world.env.PATH}`
  return world
}

function project(world: DaemonWorld, name: string): string {
  const dir = join(world.dataDir, 'projects', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}')
  // As the CLI sees it from `process.cwd()`: the temp dir is behind a symlink on macOS.
  return realpathSync(dir)
}

/** A dev server whose page says which one it is, and which holds websockets
 *  open the way vite's HMR does. */
async function devServer(name: string): Promise<{ origin: string; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>()
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><head></head><body><h1>${name}</h1></body></html>`)
  })
  server.on('upgrade', (_req, socket: Socket) => {
    sockets.add(socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sockets }
}

const state = async (world: DaemonWorld, port: number) => (await world.state(port)) as unknown as State

test('CV-cli-resolve: poll, progress and end find the session by the project they run from', async () => {
  const world = await newWorld()
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const P = project(world, 'p')
  const Q = project(world, 'q')
  const R = project(world, 'r')
  const p = await world.openSession(control, { url: 'http://localhost:5173/', project: P })
  const q = await world.openSession(control, { url: 'http://localhost:5199/', project: Q })

  const plain = await world.run(['progress', 'working'], { cwd: P })
  assert.equal(plain.code, 0, plain.stderr)
  assert.equal((await state(world, p.port)).agentProgress, 'working')

  const mismatched = await world.run(['progress', 'http://localhost:5999', 'still working'], { cwd: P })
  assert.equal(mismatched.code, 0, mismatched.stderr)
  assert.match(
    mismatched.stderr,
    /note: http:\/\/localhost:5999 is not this project's app \(attached: http:\/\/localhost:5173\); using the project session/,
  )
  assert.equal((await state(world, p.port)).agentProgress, 'still working')

  const ended = await world.run(['end'], { cwd: Q })
  assert.equal(ended.code, 0, ended.stderr)
  assert.equal((await state(world, q.port)).state, 'ended')
  assert.equal((await state(world, p.port)).state, 'active')

  const lost = await world.run(['poll'], { cwd: R })
  assert.notEqual(lost.code, 0)
  assert.match(lost.stderr, new RegExp(`no session for ${R}`))
  assert.ok(lost.stderr.includes(P), lost.stderr)
  assert.ok(!lost.stderr.includes(`  ${Q}`), 'an ended session is not offered')
})

test('CV-p2-attach-keeps-chat: a dev server that moves ports keeps the conversation', async () => {
  const world = await newWorld()
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const P = project(world, 'moving')
  const a = await devServer('app on a')
  const first = await world.openSession(control, { url: `${a.origin}/`, project: P, agent: FAKE_AGENT })
  await waitFor(async () => (await state(world, first.port)).acp?.state === 'idle', 'the agent')
  await world.sendFeedback(first.port, 'make the hero bigger')
  const before = (await state(world, first.port)).conversation

  const b = await devServer('app on b')
  const second = await world.openSession(control, { url: `${b.origin}/pricing`, project: P })
  assert.equal(second.port, first.port)
  assert.equal(second.shellUrl, `http://127.0.0.1:${first.port}/__ezdesign/shell?path=%2Fpricing`)
  const after = await state(world, first.port)
  assert.equal(after.app, b.origin)
  assert.deepEqual(after.conversation.slice(0, before.length), before)
  const page = await (await fetch(`http://127.0.0.1:${first.port}/`, { headers: { accept: 'text/html' } })).text()
  assert.match(page, /app on b/)
  assert.match(page, /\/__ezdesign\/overlay\.js/)
})

test('CV-p2-origin-handoff: another project taking the origin leaves the first its session', async () => {
  const world = await newWorld()
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const P = project(world, 'holder')
  const Q = project(world, 'taker')
  const app = await devServer('the shared app')
  const p = await world.openSession(control, { url: `${app.origin}/`, project: P })
  await world.postFeedback(p.port, 'queued before the handoff')

  const sse = request(`http://127.0.0.1:${p.port}/__ezdesign/api/events`)
  sse.end()
  await new Promise<IncomingMessage>((r) => sse.once('response', r))
  const hmr = request(`http://127.0.0.1:${p.port}/@vite/hmr`, {
    headers: { connection: 'Upgrade', upgrade: 'websocket' },
  })
  hmr.end()
  const upgraded = await new Promise<Socket>((r) => hmr.once('upgrade', (_res, socket) => r(socket)))
  const closed = new Promise<void>((r) => upgraded.once('close', () => r()))

  const started = Date.now()
  const q = await world.openSession(control, { url: `${app.origin}/`, project: Q })
  assert.ok(Date.now() - started < 3_000)
  await closed

  const held = await state(world, p.port)
  assert.equal(held.state, 'active')
  assert.equal(held.app, undefined)
  assert.equal(held.conversation.filter((e) => e.role === 'user').length, 1)
  const shell = await fetch(`http://127.0.0.1:${p.port}/__ezdesign/shell`)
  assert.equal(shell.status, 200)
  assert.match(await shell.text(), /data-app=""/, 'a shell served with no app mounts no preview')
  const root = await fetch(`http://127.0.0.1:${p.port}/`, { headers: { accept: 'text/html' } })
  assert.equal(root.status, 404)
  assert.doesNotMatch(await root.text(), /the shared app/)
  const topLevel = await fetch(`http://127.0.0.1:${p.port}/`, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
    redirect: 'manual',
  })
  assert.equal(topLevel.status, 302)
  assert.equal(topLevel.headers.get('location'), '/__ezdesign/shell')
  const preview = await fetch(`http://127.0.0.1:${p.port}/`, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' },
  })
  assert.equal(preview.status, 200)
  assert.match(await preview.text(), /No dev server is attached/)
  assert.equal((await state(world, q.port)).app, app.origin)
  const shellWithApp = await (await fetch(`http://127.0.0.1:${q.port}/__ezdesign/shell`)).text()
  assert.ok(shellWithApp.includes(`data-app="${app.origin}"`), 'the shell knows its app before any snapshot')
  sse.destroy()
})

test('CV-p2-restore: a stop brings back what was live on the same ports; an idle exit does not', async () => {
  const world = await newWorld()
  world.spawnDaemon()
  const first = await world.liveDaemon()
  const P = project(world, 'with-agent')
  const Q = project(world, 'plain')
  const p = await world.openSession(first.port, { url: 'http://localhost:5301/', project: P, agent: FAKE_AGENT })
  const q = await world.openSession(first.port, { url: 'http://localhost:5302/', project: Q })
  await waitFor(async () => (await state(world, p.port)).acp?.state === 'idle', 'the agent')
  await world.postFeedback(q.port, 'waiting for a poller')

  await world.stopDaemon(first.port)
  world.spawnDaemon()
  await world.liveDaemon()
  const listed = await world.run(['status'])
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, new RegExp(`session: ${P} → 127\\.0\\.0\\.1:${p.port} \\(active\\)\\n\\s+app: http://localhost:5301`))
  assert.match(listed.stdout, new RegExp(`session: ${Q} → 127\\.0\\.0\\.1:${q.port} \\(active\\)`))
  await waitFor(async () => (await state(world, p.port)).acp?.state === 'idle', 'the restored agent')

  // What the idle exit leaves behind: every record cleared of restoreOnStart.
  const second = await world.liveDaemon()
  await world.stopDaemon(second.port)
  for (const dir of [P, Q]) {
    const file = join(world.dataDir, 'sessions', sessionKey(dir), 'session.json')
    const { restoreOnStart: _cleared, ...rest } = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify(rest))
  }
  world.spawnDaemon()
  await world.liveDaemon()
  const empty = await world.run(['status'])
  assert.match(empty.stdout, /sessions: none/)

  const woken = await world.run(['poll'], { cwd: Q })
  assert.equal(woken.code, 0, woken.stderr)
  const batch = JSON.parse(woken.stdout) as { type: string; url: string; items: { comment: string }[] }
  assert.equal(batch.type, 'feedback')
  assert.equal(batch.url, 'http://localhost:5302')
  assert.deepEqual(batch.items.map((i) => i.comment), ['waiting for a poller'])
  const after = await world.run(['status'])
  assert.match(after.stdout, new RegExp(`session: ${Q} → 127\\.0\\.0\\.1:${q.port} \\(active\\)`))
  assert.doesNotMatch(after.stdout, new RegExp(P))
})

test('CV-flag-removed: an open without a url opens the project on its canvases', async () => {
  const world = await newWorld()
  const P = project(world, 'empty-start')
  // From source the CLI cannot launch a daemon of its own, so one is waiting.
  world.spawnDaemon()
  await world.liveDaemon()
  const opened = await world.run([], { cwd: P })
  assert.equal(opened.code, 0, opened.stderr)
  assert.match(opened.stdout, new RegExp(`^session: ${P}$`, 'm'))
  assert.doesNotMatch(opened.stdout, /^app:/m)
  const shellUrl = /^shell: +(\S+)$/m.exec(opened.stdout)![1]!
  assert.equal(shellUrl.endsWith('/__ezdesign/shell'), true)
  assert.equal((await fetch(shellUrl)).status, 200)
  const port = Number(new URL(shellUrl).port)
  const state = (await world.state(port)) as unknown as State & { canvas: { canvases: unknown[] } }
  assert.equal(state.app, undefined)
  assert.deepEqual(state.canvas.canvases, [], 'the empty canvas waits for a shell to connect')
  const help = await world.run(['--help'], { cwd: P })
  assert.match(help.stdout, /ezdesign \[<url>\]/)
})

/** A review shell's event stream: reconnects whenever it drops, as a browser's does. */
function holdShell(port: number): { connected: () => boolean; close: () => void } {
  let live: ReturnType<typeof request> | null = null
  let connected = false
  let closed = false
  const connect = () => {
    if (closed) return
    const req = request(`http://127.0.0.1:${port}/__ezdesign/api/events?shell=1`)
    live = req
    req.on('response', (res) => {
      connected = true
      res.on('close', retry)
    })
    req.on('error', retry)
    req.end()
  }
  const retry = () => {
    connected = false
    if (!closed) setTimeout(connect, 200)
  }
  connect()
  return {
    connected: () => connected,
    close: () => {
      closed = true
      live?.destroy()
    },
  }
}

test('a shell left open across a restart is waited for, so ezdesign opens no second window', async () => {
  const world = await newWorld()
  world.spawnDaemon()
  const first = await world.liveDaemon()
  const P = project(world, 'kept-open')
  const Q = project(world, 'closed')
  const p = await world.openSession(first.port, { url: 'http://localhost:5311/', project: P })
  const q = await world.openSession(first.port, { url: 'http://localhost:5312/', project: Q })
  assert.equal(p.shellOpen, false, 'nothing open yet')
  const shell = holdShell(p.port)
  await waitFor(async () => shell.connected(), 'the shell to connect')
  assert.equal((await world.openSession(first.port, { project: P })).shellOpen, true)

  await world.stopDaemon(first.port)
  world.spawnDaemon()
  const second = await world.liveDaemon()
  const reopened = await world.openSession(second.port, { project: P })
  assert.equal(reopened.port, p.port)
  assert.equal(reopened.shellOpen, true, 'the open shell reconnected before the answer')
  const other = await world.openSession(second.port, { project: Q })
  assert.equal(other.port, q.port)
  assert.equal(other.shellOpen, false, 'no shell was open on it to wait for')
  shell.close()
})

test('an app that stops answering gets a page that reloads itself once the app is back', async () => {
  const world = await newWorld()
  world.spawnDaemon()
  const daemon = await world.liveDaemon()
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><h1>back</h1>'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  const opened = await world.openSession(daemon.port, { url: `http://127.0.0.1:${port}/`, project: project(world, 'stops') })
  await new Promise<void>((r) => server.close(() => r()))

  const page = await fetch(`http://127.0.0.1:${opened.port}/`, { headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' } })
  assert.equal(page.status, 502)
  assert.equal(page.headers.get('x-ezdesign-unreachable'), '1')
  const html = await page.text()
  assert.match(html, /連不上 App/)
  assert.match(html, new RegExp(`127\\.0\\.0\\.1:${port}`))
  const asset = await fetch(`http://127.0.0.1:${opened.port}/main.js`)
  assert.deepEqual([asset.status, asset.headers.get('x-ezdesign-unreachable'), await asset.text()], [502, '1', ''])

  const back = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><h1>back</h1>'))
  servers.push(back)
  await new Promise<void>((r) => back.listen(port, '127.0.0.1', () => r()))
  const again = await fetch(`http://127.0.0.1:${opened.port}/`, { method: 'HEAD' })
  assert.deepEqual([again.status, again.headers.get('x-ezdesign-unreachable')], [200, null], 'what the page polls for')
})
