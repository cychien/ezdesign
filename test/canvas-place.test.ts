import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GAP, ROW_LIMIT, autoPlace, defaultHeightFor, normalizeRect, overlaps } from '../src/canvas/place.js'

const phone = { width: 390, height: 844 }
const placedClear = (existing: { x: number; y: number; width: number; height: number }[]) => {
  const at = autoPlace(existing, phone)
  const rect = { ...at, ...phone }
  assert.ok(!existing.some((r) => overlaps(rect, r)), `${JSON.stringify(rect)} overlaps`)
  return at
}

test('CV-auto-place: an empty board starts at the origin, a second frame goes beside the first', () => {
  assert.deepEqual(placedClear([]), { x: 0, y: 0 })
  assert.deepEqual(placedClear([{ x: 0, y: 0, width: 1280, height: 800 }]), { x: 1280 + GAP, y: 0 })
})

test('CV-auto-place: an irregular cluster with negative coordinates is cleared, not overlapped', () => {
  const cluster = [
    { x: -600, y: -200, width: 500, height: 400 },
    { x: 0, y: 0, width: 1280, height: 800 },
    { x: 1400, y: -100, width: 390, height: 844 },
    { x: 200, y: 900, width: 800, height: 600 },
    { x: 1900, y: 300, width: 390, height: 844 },
    { x: -500, y: 1000, width: 300, height: 300 },
    { x: 1500, y: 800, width: 300, height: 200 },
  ]
  assert.deepEqual(placedClear(cluster), { x: 2370, y: -200 })
})

test('CV-auto-place: a full row wraps under everything', () => {
  const row = Array.from({ length: 6 }, (_, i) => ({ x: i * 1360, y: 0, width: 1280, height: 800 }))
  assert.ok(row[5]!.x + 1280 + GAP + 390 > ROW_LIMIT)
  assert.deepEqual(placedClear(row), { x: 0, y: 800 + GAP })
})

test('a rect from the wire is whole and inside the size limits', () => {
  assert.deepEqual(normalizeRect({ x: 1.4, y: -2.6, width: 10, height: 99999 }), {
    x: 1,
    y: -3,
    width: 240,
    height: 12000,
  })
  assert.deepEqual([390, 768, 1280].map(defaultHeightFor), [844, 1024, 800])
})
