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

async function world() {
  const w = await DaemonWorld.create()
  worlds.push(w)
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
  const { w, control } = await world()
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

test('CV-tool-isolation and CV-flag-removed: every session gets its own canvas tools, and only it can use them', async () => {
  const { w, control } = await world()
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
})

test('CV-external-edit and CV-p5-brief: a file edited outside reaches the shell, and turns say where the user is', async () => {
  const { w, control } = await world()
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

test("CV-auto-place: each of the agent's turns adds its frames as a row of its own, left to right", async () => {
  const { w, control } = await world()
  const dir = project(w)
  const port = await ready(w, control, dir)
  for (const frames of [3, 6]) {
    await api(port, '/send', { note: '建立 design system', view: { tab: 'app', page: '/' } })
    await waitFor(async () => {
      const s = (await w.state(port)) as unknown as State
      return s.canvas?.canvases.find((c) => c.frames === frames) && s.acp?.state === 'idle'
    }, `${frames} frames`, 15_000)
  }
  const canvas = ((await w.state(port)) as unknown as State).canvas!.canvases.find((c) => c.name === 'Design system')!
  const manifest = JSON.parse(readFileSync(join(dir, '.ezdesign', 'canvases', canvas.id, 'canvas.json'), 'utf8'))
  const layout = JSON.parse(readFileSync(join(dir, '.ezdesign', 'canvases', canvas.id, 'layout.json'), 'utf8'))
  const placed = manifest.frames.map((f: { id: string }) => [layout.rects[f.id].x, layout.rects[f.id].y])
  const row = (y: number) => [[0, y], [470, y], [940, y]]
  assert.deepEqual(placed, [...row(0), ...row(844 + 240)])
})

test('CV-p6-agent-geometry: the agent cannot move a frame the user placed', async () => {
  const { w, control } = await world()
  const dir = project(w)
  const port = await ready(w, control, dir)
  await api(port, '/send', { note: '建立 design system', view: { tab: 'app', page: '/' } })
  const canvas = await waitFor(async () => {
    const s = (await w.state(port)) as unknown as State
    return s.canvas?.canvases.find((c) => c.frames === 3)
  }, 'the canvas', 15_000)
  await waitFor(async () => ((await w.state(port)) as unknown as State).acp?.state === 'idle', 'the turn to end')
  const wire = (await (await fetch(`http://127.0.0.1:${port}/__ezdesign/api/canvases/${canvas.id}`)).json()) as { frames: { id: string }[] }
  const first = wire.frames[0]!
  const moved = await api(port, `/canvases/${canvas.id}/ops`, {
    opId: 'user-move',
    ops: [{ t: 'move', frames: [{ id: first.id, x: 900, y: 0 }] }],
  })
  assert.equal(moved.status, 200)

  const server = Object.values((await report(w, port)).mcpServers).flat().find((s) => s.name === 'ezdesign-canvas')!
  const call = async (name: string, args: unknown) => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: server.headers[0]!.value },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    return (await res.json()) as { result?: { isError?: boolean; content: { text: string }[]; structuredContent?: { frames: { frameId: string; x: number; y: number }[] } } }
  }
  const updated = await call('update_frame', { canvasId: canvas.id, frameId: first.id, html: '<!doctype html><html><body>new</body></html>' })
  assert.notEqual(updated.result?.isError, true)
  const sneaky = await call('update_frame', { canvasId: canvas.id, frameId: first.id, x: 0 })
  assert.equal(sneaky.result?.isError, true)
  assert.match(sneaky.result!.content[0]!.text, /x/)
  const read = await call('read_canvas', { canvasId: canvas.id })
  const listed = read.result!.structuredContent!.frames.find((f) => f.frameId === first.id)!
  assert.deepEqual([listed.x, listed.y], [900, 0])
  const layout = JSON.parse(readFileSync(join(dir, '.ezdesign', 'canvases', canvas.id, 'layout.json'), 'utf8'))
  assert.deepEqual([layout.rects[first.id].x, layout.rects[first.id].y], [900, 0])
})

test('CV-agent-height: update_frame grows a frame over MCP, the frame under it moves down, and its width stays fixed', async () => {
  const { w, control } = await world()
  const dir = project(w)
  const port = await ready(w, control, dir)
  for (const frames of [3, 6]) {
    await api(port, '/send', { note: '建立 design system', view: { tab: 'app', page: '/' } })
    await waitFor(async () => {
      const s = (await w.state(port)) as unknown as State
      return s.canvas?.canvases.find((c) => c.frames === frames) && s.acp?.state === 'idle'
    }, `${frames} frames`, 15_000)
  }
  const canvas = ((await w.state(port)) as unknown as State).canvas!.canvases.find((c) => c.name === 'Design system')!
  const server = Object.values((await report(w, port)).mcpServers).flat().find((s) => s.name === 'ezdesign-canvas')!
  const call = async (name: string, args: unknown) => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: server.headers[0]!.value },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    return (await res.json()) as { result?: { isError?: boolean; content: { text: string }[]; structuredContent?: { height: number } } }
  }
  const board = async () =>
    ((await (await fetch(`http://127.0.0.1:${port}/__ezdesign/api/canvases/${canvas.id}`)).json()) as {
      frames: { id: string; rect: { x: number; y: number; width: number; height: number } }[]
    }).frames.map((f) => [f.rect.x, f.rect.y, f.rect.width, f.rect.height])
  const first = ((await (await fetch(`http://127.0.0.1:${port}/__ezdesign/api/canvases/${canvas.id}`)).json()) as { frames: { id: string }[] }).frames[0]!
  const wider = await call('update_frame', { canvasId: canvas.id, frameId: first.id, width: 1280 })
  assert.equal(wider.result?.isError, true)
  assert.match(wider.result!.content[0]!.text, /width/)
  const grown = await call('update_frame', { canvasId: canvas.id, frameId: first.id, height: 1444 })
  assert.notEqual(grown.result?.isError, true)
  assert.equal(grown.result?.structuredContent?.height, 1444)
  assert.deepEqual(await board(), [
    [0, 0, 390, 1444],
    [470, 0, 390, 844],
    [940, 0, 390, 844],
    [0, 1684, 390, 844],
    [470, 1084, 390, 844],
    [940, 1084, 390, 844],
  ])
})

// The user's `#` decides where the result goes. It reaches the agent as an
// instruction and as the words the user wrote, the thread keeps what they picked
// by name, and a place this review does not have is refused rather than guessed.
test('a # in the note box sends the batch to that place, and only to a place that exists', async () => {
  const { w, control } = await world()
  const port = await ready(w, control, project(w))
  const created = (await (await api(port, '/canvases', { name: 'Design system' })).json()) as { id: string }

  const sent = async (note: string, target: unknown) => {
    const before = ((await w.state(port)) as unknown as State).conversation.length
    const res = await api(port, '/send', { note, target })
    if (!res.ok) return res.status
    await waitFor(async () => {
      const s = (await w.state(port)) as unknown as State
      return s.acp?.state === 'idle' && s.conversation.slice(before).some((e) => e.role === 'agent')
    }, `the turn for ${note}`)
    return res.status
  }
  assert.equal(await sent('三個版本 [target 1]', { kind: 'canvas', canvasId: created.id }), 200)
  assert.equal(await sent('標題改大 [target 1]', { kind: 'app' }), 200)
  assert.equal(await sent('nowhere [target 1]', { kind: 'canvas', canvasId: '000000000000' }), 400)
  assert.equal(await sent('nowhere [target 1]', { kind: 'moon' }), 400)

  const { prompts } = await report(w, port)
  const onCanvas = prompts.find((p) => p.text.includes('三個版本'))!.text
  assert.match(onCanvas, /"note": "三個版本 #Design system"/, 'the agent reads what the user typed')
  assert.ok(
    onCanvas.includes(`The user marked this batch #Design system, so that is where the result goes: put it on canvas "Design system" (${created.id}) as frames.`),
  )
  assert.ok(!onCanvas.includes('Add new frames to canvas'), 'the default canvas is not offered alongside')
  const onApp = prompts.find((p) => p.text.includes('標題改大'))!.text
  assert.ok(onApp.includes("The user marked this batch #App, so that is where the result goes: make the change in the app's own source."))

  const thread = ((await w.state(port)) as unknown as { conversation: { target?: { label: string } }[] }).conversation
  const labels = thread.flatMap((e) => (e.target ? [e.target.label] : []))
  assert.deepEqual(labels, ['Design system', 'App'], 'the thread keeps what was picked, by name')
  const notes = (await (await fetch(`http://127.0.0.1:${port}/__ezdesign/api/sent-notes`)).json()) as { target?: { label: string } }[]
  assert.deepEqual(
    notes.slice(1, 3).map((n) => n.target?.label),
    ['App', 'Design system'],
    'Up brings the # back with the message',
  )
})
