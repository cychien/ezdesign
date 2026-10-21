import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const worlds: DaemonWorld[] = []
after(() => Promise.all(worlds.map((w) => w.dispose())))

interface State {
  acp?: { state: string; ask?: unknown }
  conversation: { role: string; text: string }[]
  canvas?: { canvases: { id: string; name: string; frames: number }[]; activeTab: string | null; agentHasTools: boolean }
}

async function world(canvas: boolean) {
  const w = await DaemonWorld.create()
  worlds.push(w)
  if (canvas) w.env.EZDESIGN_CANVAS = '1'
  w.spawnDaemon()
  return { w, control: (await w.liveDaemon()).port }
}

function project(w: DaemonWorld): string {
  const dir = realpathSync(mkdtempSync(join(w.dataDir, 'project-')))
  writeFileSync(join(dir, 'package.json'), '{}')
  return dir
}

const api = (port: number, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/__ezdesign/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function ready(w: DaemonWorld, control: number, dir: string) {
  const { port } = await w.openSession(control, { url: 'http://127.0.0.1:9/', project: dir, agent: FAKE_AGENT })
  await waitFor(async () => ((await w.state(port)) as unknown as State).acp?.state === 'idle', 'the agent')
  return port
}

async function report(w: DaemonWorld, port: number) {
  const before = ((await w.state(port)) as unknown as State).conversation.length
  await api(port, '/send', { note: 'REPORT' })
  const said = await waitFor(async () => {
    const s = (await w.state(port)) as unknown as State
    return s.conversation.slice(before).find((e) => e.role === 'agent' && e.text.includes('"prompts"'))
  }, 'the agent to report')
  return JSON.parse(said.text) as {
    prompts: { text: string }[]
    log: string[]
    mcpServers: Record<string, { name: string; url: string; headers: { name: string; value: string }[] }[]>
  }
}

test('CV-agent-builds-canvas: the agent makes a canvas and fills it, and the tab follows', async () => {
  const { w, control } = await world(true)
  const dir = project(w)
  const port = await ready(w, control, dir)
  assert.equal(((await w.state(port)) as unknown as State).canvas?.agentHasTools, true)
  await api(port, '/send', { note: '建立 design system', view: { tab: 'app', page: '/' } })
  const done = await waitFor(async () => {
    const s = (await w.state(port)) as unknown as State
    return s.canvas?.canvases.find((c) => c.name === 'Design system' && c.frames === 3) ? s : null
  }, 'three frames on the new canvas', 15_000)
  const canvas = done.canvas!.canvases.find((c) => c.name === 'Design system')!
  assert.equal(done.canvas!.activeTab, canvas.id)
  const manifest = JSON.parse(readFileSync(join(dir, '.ezdesign', 'canvases', canvas.id, 'canvas.json'), 'utf8'))
  assert.deepEqual(manifest.frames.map((f: { title: string }) => f.title), ['Colors', 'Type', 'Buttons'])
  const layout = JSON.parse(readFileSync(join(dir, '.ezdesign', 'canvases', canvas.id, 'layout.json'), 'utf8'))
  const rects = Object.values(layout.rects) as { x: number; width: number }[]
  rects.sort((a, b) => a.x - b.x)
  for (let i = 1; i < rects.length; i++) assert.ok(rects[i]!.x >= rects[i - 1]!.x + rects[i - 1]!.width, 'no overlap')
  const reply = await waitFor(async () => {
    const s = (await w.state(port)) as unknown as State
    return s.conversation.find((e) => e.role === 'agent' && e.text.includes('add_frame'))
  }, 'the agent reply')
  assert.ok(!reply.text.includes('isError'))
  const { log } = await report(w, port)
  const asked = log.filter((l) => l.startsWith('permission:mcp__ezdesign-canvas__'))
  assert.equal(asked.length, 5)
  assert.ok(asked.every((l) => l.endsWith(':allow-once')), 'every canvas tool is granted without a card')
})

test('CV-tool-isolation and CV-p5-flag-off: only this session holds its canvas tools', async () => {
  const { w, control } = await world(true)
  const p = await ready(w, control, project(w))
  const q = await ready(w, control, project(w))
  const servers = async (port: number) => Object.values((await report(w, port)).mcpServers).flat()
  const pServer = (await servers(p)).find((s) => s.name === 'ezdesign-canvas')!
  const qServer = (await servers(q)).find((s) => s.name === 'ezdesign-canvas')!
  assert.equal((await servers(p)).filter((s) => s.name === 'ezdesign-canvas').length, 1)
  const call = (headers: Record<string, string>) =>
    fetch(pServer.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_canvas', arguments: { name: 'x' } } }),
    })
  const refused = [
    await call({ authorization: qServer.headers[0]!.value }),
    await call({}),
    await call({ authorization: 'Bearer nope' }),
  ]
  const bodies = await Promise.all(refused.map((r) => r.json()))
  assert.deepEqual(refused.map((r) => r.status), [404, 404, 404])
  assert.ok(bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0]) && b.error.code === -32004))
  const browser = await call({ authorization: pServer.headers[0]!.value, 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' })
  assert.equal(browser.status, 403)
  const before = ((await w.state(p)) as unknown as State).canvas!.canvases.length
  assert.equal(before, 0, 'nothing was created by any refused call')

  const off = await world(false)
  const r = await ready(off.w, off.control, project(off.w))
  const offServers = Object.values((await report(off.w, r)).mcpServers).flat()
  assert.ok(!offServers.some((s) => s.name === 'ezdesign-canvas'))
  assert.equal((await api(r, '/mcp/canvas', {})).status, 404)
})

test('CV-external-edit and CV-p5-brief: a file edited outside reaches the shell, and turns say where the user is', async () => {
  const { w, control } = await world(true)
  const dir = project(w)
  const port = await ready(w, control, dir)
  await api(port, '/send', { note: '建立 design system', view: { tab: 'app', page: '/' } })
  const canvas = await waitFor(async () => {
    const s = (await w.state(port)) as unknown as State
    return s.canvas?.canvases.find((c) => c.frames === 3)
  }, 'the canvas', 15_000)
  await waitFor(async () => ((await w.state(port)) as unknown as State).acp?.state === 'idle', 'the turn to end')
  const framesDir = join(dir, '.ezdesign', 'canvases', canvas.id, 'frames')
  const [second] = readdirSync(framesDir).sort().slice(1)

  const controller = new AbortController()
  const events = await fetch(`http://127.0.0.1:${port}/__ezdesign/api/events?shell=1`, { signal: controller.signal })
  const reader = events.body!.getReader()
  let seen = ''
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
      if (done) return
      seen += new TextDecoder().decode(value)
    }
  })()
  await waitFor(async () => seen.includes('data: {"version"'), 'the first flush')
  const flushed = seen.length
  const count = () => seen.slice(flushed).split('event: canvas\n').length - 1
  const html = '<!doctype html><html><body><h1>外部修改</h1></body></html>'
  writeFileSync(join(framesDir, second!), html)
  await waitFor(async () => count() === 1, 'the edit to reach the shell', 2_000)
  assert.match(seen.slice(flushed), /外部修改|"hash"/)
  writeFileSync(join(framesDir, second!), html)
  appendFileSync(join(dir, '.ezdesign', 'canvases', canvas.id, 'canvas.json'), ' ')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(count(), 1, 'an identical rewrite and a manifest edit send nothing')
  controller.abort()
  await pump

  await api(port, '/send', { note: 'on the canvas', view: { tab: 'canvas', canvasId: canvas.id } })
  await waitFor(async () => {
    const s = (await w.state(port)) as unknown as State
    return s.conversation.some((e) => e.role === 'agent' && e.text.includes('on the canvas'))
  }, 'the canvas turn')
  await api(port, '/send', { note: 'on the app', view: { tab: 'app', page: '/pricing' } })
  await waitFor(async () => {
    const s = (await w.state(port)) as unknown as State
    return s.conversation.some((e) => e.role === 'agent' && e.text.includes('on the app'))
  }, 'the app turn')
  const { prompts } = await report(w, port)
  const onCanvas = prompts.find((p) => p.text.includes('on the canvas'))!.text
  const onApp = prompts.find((p) => p.text.includes('on the app'))!.text
  assert.ok(onCanvas.includes(`The user was on canvas "Design system" (${canvas.id}) when they sent this.`))
  assert.ok(onCanvas.includes(`canvas "Design system" (${canvas.id}, 3 frames)`))
  assert.ok(onApp.includes('The user was on the App tab at /pricing when they sent this.'))
  for (const text of [onCanvas, onApp]) assert.ok(text.includes('Never edit canvas.json or layout.json.'))
  assert.equal((await api(port, '/send', { note: 'x', view: { tab: 'nowhere' } })).status, 400)
})
