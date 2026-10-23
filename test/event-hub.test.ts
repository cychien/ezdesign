import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventHub, type HubEvent, STREAM_STATE, type SourceLike } from '../src/client/event-hub.js'

class FakeSource implements SourceLike {
  closed = false
  readyState = 0
  private readonly listeners = new Map<string, ((e: { data: string }) => void)[]>()
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (e: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, data: string): void {
    for (const l of this.listeners.get(type) ?? []) l({ data })
  }
  close(): void {
    this.closed = true
  }
}

function world() {
  const sources: FakeSource[] = []
  const timers: (() => void)[] = []
  const hub = new EventHub(
    (url) => {
      const s = new FakeSource(url)
      sources.push(s)
      return s
    },
    (run) => {
      timers.push(run)
      return setTimeout(() => {}, 0)
    },
  )
  const port = () => {
    const got: HubEvent[] = []
    return { got, postMessage: (m: HubEvent) => got.push(m) }
  }
  return { hub, sources, timers, port }
}

const EVENTS = 'http://127.0.0.1:5000/__ezdesign/api/events'

test('every tab is served from one stream', () => {
  const { hub, sources, port } = world()
  const a = port()
  const b = port()
  hub.receive(a, { t: 'subscribe', url: EVENTS, events: ['message'] })
  hub.receive(b, { t: 'subscribe', url: EVENTS, events: ['message'] })
  sources.at(-1)!.emit('open', '')
  assert.equal(sources.filter((s) => !s.closed).length, 1)
  sources.at(-1)!.emit('message', '{"n":1}')
  const up = { type: STREAM_STATE, data: 'open' }
  assert.deepEqual(a.got, [up, { type: 'message', data: '{"n":1}' }])
  assert.deepEqual(b.got, [up, { type: 'message', data: '{"n":1}' }])
})

test('a tab that joins gets a fresh flush, and the stream it replaced goes quiet', () => {
  const { hub, sources, port } = world()
  const a = port()
  hub.receive(a, { t: 'subscribe', url: EVENTS, events: ['message'] })
  const first = sources[0]!
  hub.receive(port(), { t: 'subscribe', url: EVENTS, events: ['message'] })
  assert.equal(sources.length, 2)
  first.emit('message', 'stale')
  assert.deepEqual(a.got, [])
  assert.equal(first.closed, false, 'kept until the new stream is up')
  sources[1]!.emit('open', '')
  assert.equal(first.closed, true)
})

test('named events are forwarded once any tab asks for them', () => {
  const { hub, sources, port } = world()
  const a = port()
  hub.receive(a, { t: 'subscribe', url: EVENTS, events: ['message'] })
  hub.receive(port(), { t: 'subscribe', url: EVENTS, events: ['canvas'] })
  sources.at(-1)!.emit('canvas', 'c')
  assert.deepEqual(a.got, [{ type: 'canvas', data: 'c' }])
})

test('the stream closes when the last tab leaves, and reopens for the next', () => {
  const { hub, sources, port } = world()
  const a = port()
  const b = port()
  hub.receive(a, { t: 'subscribe', url: EVENTS, events: ['message'] })
  hub.receive(b, { t: 'subscribe', url: EVENTS, events: ['message'] })
  hub.receive(a, { t: 'leave' })
  sources.at(-1)!.emit('message', 'x')
  assert.deepEqual(a.got, [])
  assert.deepEqual(b.got, [{ type: 'message', data: 'x' }])
  hub.receive(b, { t: 'leave' })
  assert.ok(sources.every((s) => s.closed), 'the retired stream too, though its successor never opened')
  hub.receive(b, { t: 'subscribe', url: EVENTS, events: ['message'] })
  assert.equal(sources.length, 3)
  assert.equal(sources.at(-1)!.closed, false)
})

test('every tab hears when the stream drops and when it is back', () => {
  const { hub, sources, port } = world()
  const a = port()
  hub.receive(a, { t: 'subscribe', url: EVENTS, events: ['message'] })
  const source = sources[0]!
  source.emit('open', '')
  source.emit('error', '')
  source.emit('open', '')
  assert.deepEqual(
    a.got.map((e) => e.data),
    ['open', 'down', 'open'],
  )
})

test('a replaced stream going down says nothing about the live one', () => {
  const { hub, sources, port } = world()
  const a = port()
  hub.receive(a, { t: 'subscribe', url: EVENTS, events: ['message'] })
  hub.receive(port(), { t: 'subscribe', url: EVENTS, events: ['message'] })
  sources[0]!.emit('error', '')
  assert.deepEqual(a.got, [])
})

test('a stream the browser gave up on is reopened by the hub', () => {
  const { hub, sources, timers, port } = world()
  const a = port()
  hub.receive(a, { t: 'subscribe', url: EVENTS, events: ['message'] })
  const first = sources[0]!
  first.emit('error', '')
  assert.equal(timers.length, 0, 'a stream still connecting retries by itself')
  first.readyState = 2
  first.emit('error', '')
  assert.equal(timers.length, 1)
  timers[0]!()
  assert.equal(sources.length, 2)
  sources[1]!.emit('open', '')
  sources[1]!.emit('message', 'back')
  assert.deepEqual(a.got.at(-1), { type: 'message', data: 'back' })
})
