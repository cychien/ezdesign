import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_FRAME_SIZE, MIN_IMAGE_SIZE } from '../src/canvas/types.js'
import { resizedRect } from '../src/client/canvas/resize.js'

const start = { x: 100, y: 100, width: 400, height: 200 }
const limits = { fromCenter: false, min: MIN_IMAGE_SIZE, max: MAX_FRAME_SIZE }

test('a corner follows the pointer along its diagonal, keeps the aspect and pins the opposite corner', () => {
  assert.deepEqual(resizedRect(start, 'se', { x: 400, y: 200 }, limits), { x: 100, y: 100, width: 800, height: 400 })
  assert.deepEqual(resizedRect(start, 'nw', { x: 200, y: 100 }, limits), { x: 300, y: 200, width: 200, height: 100 })
  assert.deepEqual(resizedRect(start, 'ne', { x: 400, y: 0 }, limits), { x: 100, y: -60, width: 720, height: 360 })
  assert.deepEqual(resizedRect(start, 'sw', { x: -400, y: 0 }, limits), { x: -220, y: 100, width: 720, height: 360 })
})

test('an edge scales by its own axis and keeps the other centred', () => {
  assert.deepEqual(resizedRect(start, 'e', { x: 400, y: 999 }, limits), { x: 100, y: 0, width: 800, height: 400 })
  assert.deepEqual(resizedRect(start, 'w', { x: 200, y: 0 }, limits), { x: 300, y: 150, width: 200, height: 100 })
  assert.deepEqual(resizedRect(start, 'n', { x: 0, y: -200 }, limits), { x: -100, y: -100, width: 800, height: 400 })
  assert.deepEqual(resizedRect(start, 's', { x: 0, y: 100 }, limits), { x: 0, y: 100, width: 600, height: 300 })
})

test('Alt resizes about the centre, each side moving the whole travel', () => {
  assert.deepEqual(resizedRect(start, 'e', { x: 100, y: 0 }, { ...limits, fromCenter: true }), { x: 0, y: 50, width: 600, height: 300 })
  assert.deepEqual(resizedRect(start, 'se', { x: 100, y: 50 }, { ...limits, fromCenter: true }), { x: 0, y: 50, width: 600, height: 300 })
})

test('it stops at the limits, aspect kept, never flipping past the anchor', () => {
  assert.deepEqual(resizedRect(start, 'se', { x: -9999, y: -9999 }, limits), { x: 100, y: 100, width: 32, height: 16 })
  assert.deepEqual(resizedRect(start, 'nw', { x: 9999, y: 9999 }, limits), { x: 468, y: 284, width: 32, height: 16 })
  assert.deepEqual(resizedRect(start, 'e', { x: 99999, y: 0 }, limits), { x: 100, y: -760, width: 3840, height: 1920 })
})
