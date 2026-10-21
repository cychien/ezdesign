import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type CanvasGuest, FrameRegistry, canvasGuestId } from '../src/client/frame-registry.js'

/** An iframe as far as the registry looks at one: its window, which records posts. */
function fakeFrame() {
  const posted: { message: unknown; origin: string }[] = []
  const contentWindow = { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) }
  return { iframe: { contentWindow } as unknown as HTMLIFrameElement, window: contentWindow, posted }
}

const SHELL = 'http://127.0.0.1:5000'
const FRAMES = 'http://localhost:5000'

function world() {
  const registry = new FrameRegistry<{ label: string }>()
  const app = fakeFrame()
  const canvas = fakeFrame()
  registry.add({ kind: 'app', id: 'single', iframe: app.iframe, origin: SHELL, label: 'desktop' })
  const place = { canvasId: 'c1', frameId: 'f1' }
  const guest: CanvasGuest = { kind: 'canvas', id: canvasGuestId(place), iframe: canvas.iframe, origin: FRAMES, place }
  registry.add(guest)
  return { registry, app, canvas }
}

test('a message is a guest\'s only from its own window and its own origin', () => {
  const { registry, app, canvas } = world()
  assert.equal(registry.from(app.window as unknown as Window, SHELL)?.id, 'single')
  assert.equal(registry.from(canvas.window as unknown as Window, FRAMES)?.id, 'canvas:c1/f1')
  assert.equal(registry.from(canvas.window as unknown as Window, SHELL), null, 'a canvas window claiming the shell origin')
  assert.equal(registry.from(app.window as unknown as Window, FRAMES), null)
  assert.equal(registry.from({} as Window, SHELL), null, "an app's own nested iframe")
  assert.equal(registry.from(null, SHELL), null)
})

test('fan-out goes to the kinds that receive a type, addressed to each guest\'s origin', () => {
  const { registry, app, canvas } = world()
  registry.postAll({ type: 'ez:set-mode', mode: 'element' })
  registry.postAll({ type: 'ez:variant', exploreId: 'e1' })
  registry.postAll({ type: 'ez:hold', held: true }, 'single')
  assert.deepEqual(app.posted, [
    { message: { type: 'ez:set-mode', mode: 'element' }, origin: SHELL },
    { message: { type: 'ez:variant', exploreId: 'e1' }, origin: SHELL },
  ])
  assert.deepEqual(canvas.posted, [
    { message: { type: 'ez:set-mode', mode: 'element' }, origin: FRAMES },
    { message: { type: 'ez:hold', held: true }, origin: FRAMES },
  ])
})

test('clearing the App previews leaves canvas guests mounted', () => {
  const { registry } = world()
  assert.equal(registry.firstAppWindow() !== null, true)
  registry.clearApps()
  assert.deepEqual(registry.all().map((g) => g.id), ['canvas:c1/f1'])
  assert.equal(registry.firstAppWindow(), null)
  assert.equal(registry.app('single'), undefined)
})
