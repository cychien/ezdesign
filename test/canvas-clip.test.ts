import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CanvasId, FrameId } from '../src/canvas/types.js'
import type { FrameWire } from '../src/canvas/wire.js'
import { FRAME_CLIP_TYPE, hasFrameClip, readFrameClip, writeFrameClip } from '../src/client/canvas/clip.js'

/** A clipboard as a copy and a paste event hand it over. */
function clipboard(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  } as unknown as DataTransfer
}

const frame: FrameWire = {
  id: '0000000000a1' as FrameId,
  title: 'hero',
  kind: 'page',
  rect: { x: 0, y: 0, width: 1280, height: 800 },
  file: '.ezdesign/canvases/aaaaaaaaaaaa/frames/0000000000a1.html',
  hash: 'h1',
  src: 'http://localhost:5000/__ezdesign/frames/aaaaaaaaaaaa/0000000000a1?rev=h1',
}

test('frames go on the clipboard as a reference of their own type, and come back as they went', () => {
  const data = clipboard()
  const clip = { origin: 'http://127.0.0.1:5000', canvasId: 'aaaaaaaaaaaa' as CanvasId, frames: [frame] }
  writeFrameClip(data, clip)
  assert.deepEqual(data.types, [FRAME_CLIP_TYPE], 'nothing a text field would paste')
  assert.ok(hasFrameClip(data))
  assert.deepEqual(readFrameClip(data), clip)
  assert.ok(data.getData(FRAME_CLIP_TYPE).length < 600, 'a reference, not the document')
})

test('anything else on the clipboard is not taken for frames', () => {
  assert.equal(hasFrameClip(clipboard({ 'text/plain': 'hi' })), false)
  assert.equal(hasFrameClip(null), false)
  const bad = (value: unknown) => readFrameClip(clipboard({ [FRAME_CLIP_TYPE]: JSON.stringify(value) }))
  const good = { origin: 'http://127.0.0.1:5000', canvasId: 'aaaaaaaaaaaa', frames: [frame] }
  assert.ok(bad(good))
  assert.equal(readFrameClip(clipboard({ [FRAME_CLIP_TYPE]: '{not json' })), null)
  assert.equal(bad({ ...good, canvasId: '../x' }), null)
  assert.equal(bad({ ...good, frames: [] }), null)
  assert.equal(bad({ ...good, frames: [frame, { ...frame, rect: { x: 0 } }] }), null, 'one bad frame spoils the clip')
  assert.equal(bad({ ...good, origin: 1 }), null)
})
