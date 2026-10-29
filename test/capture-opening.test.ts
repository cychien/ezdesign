import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BLANK_SAMPLE, isBlank, openingTimes } from '../src/extension/shared/opening.js'

test('the opening is looked for at the start, past a short fade, then a little way in', () => {
  assert.deepEqual(openingTimes(20), [0, 0.5, 1, 2, 5])
  assert.deepEqual(openingTimes(3.18), [0, 0.318, 0.5, 0.795, 1, 2])
  assert.deepEqual(openingTimes(0.4), [0, 0.04, 0.1])
  assert.deepEqual(openingTimes(Number.POSITIVE_INFINITY), [0], 'a recording that does not know its length starts at 0')
})

const frame = (pixel: (i: number) => [number, number, number]) => {
  const rgba = new Uint8ClampedArray(BLANK_SAMPLE * BLANK_SAMPLE * 4)
  for (let i = 0; i < BLANK_SAMPLE * BLANK_SAMPLE; i++) rgba.set([...pixel(i), 255], i * 4)
  return rgba
}

test('a flat black, white or slate frame is blank; a frame with anything on it is not', () => {
  assert.equal(isBlank(frame(() => [0, 0, 0])), true)
  assert.equal(isBlank(frame(() => [255, 255, 255])), true)
  assert.equal(isBlank(frame((i) => [40 + (i % 3), 40, 40])), true, 'compression noise on a slate is still a slate')
  assert.equal(isBlank(frame((i) => (i < 40 ? [20, 20, 20] : [240, 240, 240]))), false, 'a dark bar on a light page')
  assert.equal(isBlank(new Uint8ClampedArray()), true)
})
