import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CanvasId, FrameId } from '../src/canvas/types.js'
import { boxBetween, edgePan, fitAll, intersects, sanitizeCamera, screenToWorld, zoomedAround } from '../src/client/canvas/camera.js'
import { MAX_CONCURRENT_LOADS, planMounts } from '../src/client/canvas/mounting.js'
import { tabsModel } from '../src/client/canvas/tabs.js'

test('zooming keeps the world point under the cursor where it is, within bounds', () => {
  const camera = { x: 100, y: 50, zoom: 0.5 }
  const at = { x: 300, y: 200 }
  const before = screenToWorld(camera, at)
  const zoomed = zoomedAround(camera, 2, at)
  assert.equal(zoomed.zoom, 1)
  assert.deepEqual(screenToWorld(zoomed, at), before)
  assert.equal(zoomedAround(camera, 1000, at).zoom, 4)
  assert.equal(zoomedAround(camera, 0.0001, at).zoom, 0.05)
})

test('fit-all centres every frame with its margin and never zooms past 1', () => {
  const rects = [
    { x: 0, y: 0, width: 1000, height: 500 },
    { x: 1200, y: 0, width: 800, height: 1000 },
  ]
  assert.deepEqual(fitAll(rects, { width: 1096, height: 800 }), { x: -96, y: -300, zoom: 0.5 })
  assert.deepEqual(fitAll([{ x: 10, y: 10, width: 100, height: 100 }], { width: 1000, height: 1000 }), {
    x: -440,
    y: -440,
    zoom: 1,
  })
  assert.deepEqual(fitAll([], { width: 100, height: 100 }), { x: 0, y: 0, zoom: 1 })
})

test('a stored camera out of range falls back rather than blanking the board', () => {
  const fallback = { x: 0, y: 0, zoom: 1 }
  assert.deepEqual(sanitizeCamera({ x: 5, y: 6, zoom: 2 }, fallback), { x: 5, y: 6, zoom: 2 })
  assert.equal(sanitizeCamera({ x: 5, y: 6, zoom: 9 }, fallback), fallback)
  assert.equal(sanitizeCamera({ x: 'a', y: 6, zoom: 1 }, fallback), fallback)
  assert.equal(sanitizeCamera(null, fallback), fallback)
})

const id = (n: number) => n.toString(16).padStart(12, '0') as FrameId

test('mounts go to the frames nearest the view centre, six loading at a time', () => {
  const frames = Array.from({ length: 40 }, (_, i) => ({
    id: id(i),
    rect: { x: (i % 8) * 500, y: Math.floor(i / 8) * 1000, width: 390, height: 844 },
  }))
  const plan = planMounts(frames, { x: 0, y: 0, zoom: 1 }, { width: 1200, height: 900 }, {
    mounted: new Set(),
    loading: new Set(),
    pinned: new Set(),
  })
  assert.equal(plan.mount.length, MAX_CONCURRENT_LOADS)
  assert.deepEqual(plan.mount.slice(0, 2), [id(1), id(0)])
  const busy = planMounts(frames, { x: 0, y: 0, zoom: 1 }, { width: 1200, height: 900 }, {
    mounted: new Set([id(0), id(1)]),
    loading: new Set([id(0), id(1)]),
    pinned: new Set(),
  })
  assert.equal(busy.mount.length, MAX_CONCURRENT_LOADS - 2)
  assert.ok(!busy.mount.includes(id(0)))
  assert.deepEqual(busy.unmount, [])
})

test('past the soft cap the farthest offscreen frames unmount, never a pinned one', () => {
  const frames = Array.from({ length: 70 }, (_, i) => ({ id: id(i), rect: { x: i * 1000, y: 0, width: 100, height: 100 } }))
  const mounted = new Set(frames.slice(0, 62).map((f) => f.id))
  const plan = planMounts(frames, { x: 0, y: 0, zoom: 1 }, { width: 500, height: 500 }, {
    mounted,
    loading: new Set(),
    pinned: new Set([id(61)]),
  })
  assert.deepEqual(plan.mount, [])
  assert.deepEqual(plan.unmount, [id(60), id(59)])
})

test('tabs: the App first while attached, open canvases by age, a stale active tab falls back', () => {
  const c = (n: string, createdAt: number, archived = false) => ({
    id: n.repeat(12) as CanvasId,
    name: n,
    archived,
    frames: 0,
    createdAt,
  })
  const canvases = [c('b', 2), c('a', 1), c('c', 3, true)]
  const model = tabsModel(true, { canvases, activeTab: 'c'.repeat(12) as CanvasId, agentHasTools: false })
  assert.deepEqual(model.tabs.map((t) => t.label), ['App', 'a', 'b'])
  assert.equal(model.active, 'app')
  assert.deepEqual(model.all.map((x) => x.name), ['c', 'b', 'a'])
  const noApp = tabsModel(false, { canvases, activeTab: 'b'.repeat(12) as CanvasId, agentHasTools: false })
  assert.deepEqual(noApp.tabs.map((t) => [t.label, t.closable]), [
    ['a', true],
    ['b', true],
  ])
  assert.equal(noApp.active, 'b'.repeat(12))
})

test('a drag at the board edge pans toward it, faster the closer it gets, and only the way it is heading', () => {
  const stage = { width: 1000, height: 800 }
  const middle = { x: 500, y: 400 }
  assert.deepEqual(edgePan({ x: 500, y: 400 }, middle, stage), { x: 0, y: 0 })
  assert.deepEqual(edgePan({ x: 500, y: 24 }, middle, stage), { x: 0, y: 0 }, 'the zone starts inside the edge')
  assert.deepEqual(edgePan({ x: 500, y: 12 }, middle, stage), { x: 0, y: -600 })
  assert.deepEqual(edgePan({ x: 500, y: 0 }, middle, stage), { x: 0, y: -1200 })
  assert.deepEqual(edgePan({ x: 500, y: -300 }, middle, stage), { x: 0, y: -1200 }, 'past the edge is full speed')
  assert.deepEqual(edgePan({ x: 1000, y: 800 }, middle, stage), { x: 1200, y: 1200 })
  assert.deepEqual(edgePan({ x: 6, y: 400 }, middle, stage), { x: -900, y: 0 })
  const nearTop = { x: 500, y: 10 }
  assert.deepEqual(edgePan({ x: 500, y: 16 }, nearTop, stage), { x: 0, y: 0 }, 'grabbed near the edge and moved away')
  assert.deepEqual(edgePan({ x: 500, y: 6 }, nearTop, stage), { x: 0, y: -900 })
  assert.deepEqual(edgePan({ x: 50, y: 50 }, { x: 60, y: 60 }, { width: 100, height: 100 }), { x: 0, y: 0 }, 'a tiny board keeps a middle')
})

test('a selection box is the same rect whichever corner it was drawn from, and takes every frame it touches', () => {
  assert.deepEqual(boxBetween({ x: 300, y: 100 }, { x: 100, y: 400 }), { x: 100, y: 100, width: 200, height: 300 })
  assert.deepEqual(boxBetween({ x: 100, y: 400 }, { x: 300, y: 100 }), { x: 100, y: 100, width: 200, height: 300 })
  const box = boxBetween({ x: 0, y: 0 }, { x: 500, y: 500 })
  assert.equal(intersects(box, { x: 480, y: 480, width: 1280, height: 800 }), true, 'a corner is enough')
  assert.equal(intersects(box, { x: 600, y: 0, width: 390, height: 844 }), false)
})
