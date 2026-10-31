import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GAP,
  ROW_GAP,
  ROW_LIMIT,
  autoPlace,
  defaultHeightFor,
  growDown,
  imageFrameSize,
  normalizeRect,
  overlaps,
  placeBeside,
} from '../src/canvas/place.js'

const phone = { width: 390, height: 844 }
const desktop = { width: 1280, height: 820 }
type R = { x: number; y: number; width: number; height: number }

/** Adds `turns` the way an agent does, one frame at a time, and checks none
 *  ever overlaps. */
function addTurns(turns: { width: number; height: number }[][], existing: R[] = []): R[][] {
  return turns.map((sizes) => {
    const turn: R[] = []
    for (const size of sizes) {
      const rect = { ...autoPlace(existing, turn, size), ...size }
      assert.ok(!existing.some((r) => overlaps(rect, r)), `${JSON.stringify(rect)} overlaps`)
      existing.push(rect)
      turn.push(rect)
    }
    return turn
  })
}

test('CV-auto-place: an empty board starts at the origin, the rest of the turn goes beside it', () => {
  const [turn] = addTurns([[phone, phone, phone]])
  assert.deepEqual(turn!.map((r) => [r.x, r.y]), [[0, 0], [390 + GAP, 0], [2 * (390 + GAP), 0]])
})

test('CV-auto-place: each turn is a row of its own, left to right, even past a full row', () => {
  const turns = addTurns([Array(5).fill(desktop), Array(4).fill(desktop), Array(4).fill(desktop)])
  const step = 1280 + GAP
  for (const [i, turn] of turns.entries()) {
    assert.deepEqual(turn.map((r) => r.y), turn.map(() => i * (820 + ROW_GAP)), `turn ${i} shares one row`)
    assert.deepEqual(turn.map((r) => r.x), turn.map((_, j) => j * step), `turn ${i} reads left to right`)
  }
})

test('CV-auto-place: a turn wider than a row wraps under everything and keeps going', () => {
  const [turn] = addTurns([Array(8).fill(desktop)])
  const perRow = Math.floor((ROW_LIMIT + GAP) / (1280 + GAP))
  assert.ok(perRow < 8)
  assert.deepEqual(turn!.slice(perRow).map((r) => [r.x, r.y]).slice(0, 2), [[0, 820 + ROW_GAP], [1280 + GAP, 820 + ROW_GAP]])
})

test('CV-auto-place: a frame in the way is stepped over, not wrapped under', () => {
  const blocker = { x: 1280 + GAP, y: 400, width: 500, height: 300 }
  const first = { x: 0, y: 0, width: 1280, height: 800 }
  const at = autoPlace([first, blocker], [first], phone)
  assert.deepEqual(at, { x: blocker.x + blocker.width + GAP, y: 0 })
})

test('CV-auto-place: a new turn on an irregular cluster with negative coordinates starts under it', () => {
  const cluster = [
    { x: -600, y: -200, width: 500, height: 400 },
    { x: 0, y: 0, width: 1280, height: 800 },
    { x: 1400, y: -100, width: 390, height: 844 },
    { x: 200, y: 900, width: 800, height: 600 },
  ]
  assert.deepEqual(addTurns([[phone, phone]], cluster)[0]!.map((r) => [r.x, r.y]), [[-600, 1500 + ROW_GAP], [-600 + 390 + GAP, 1500 + ROW_GAP]])
})

test('a duplicate goes on its source row, past anything beside it', () => {
  const source = { x: 0, y: 0, width: 1280, height: 800 }
  assert.deepEqual(placeBeside(source, [source]), { x: 1280 + GAP, y: 0 })
  const neighbour = { x: 1280 + GAP, y: 0, width: 390, height: 844 }
  assert.deepEqual(placeBeside(source, [source, neighbour]), { x: neighbour.x + 390 + GAP, y: 0 })
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

test('a pasted image keeps its natural size, scaled down whole to fit, never under the minimum', () => {
  assert.deepEqual(imageFrameSize({ width: 1600, height: 1200 }), { width: 1600, height: 1200 })
  assert.deepEqual(imageFrameSize({ width: 7680, height: 4320 }), { width: 3840, height: 2160 })
  assert.deepEqual(imageFrameSize({ width: 1000, height: 30000 }), { width: 400, height: 12000 })
  assert.deepEqual(imageFrameSize({ width: 64, height: 32 }), { width: 240, height: 240 })
  assert.deepEqual(imageFrameSize({ width: 2000, height: 100 }), { width: 2000, height: 240 })
})

test('a frame that grows pushes down what is under it, and what is under that, by the growth', () => {
  const rect = { x: 0, y: 0, width: 1280, height: 800 }
  const others = [
    ['under', { x: 0, y: 1040, width: 1280, height: 800 }],
    ['under-under', { x: 1000, y: 2080, width: 1280, height: 800 }],
    ['beside', { x: 1360, y: 0, width: 1280, height: 800 }],
    ['elsewhere', { x: 3000, y: 1040, width: 390, height: 844 }],
  ] as const
  assert.deepEqual(growDown(rect, 1400, others), {
    rect: { x: 0, y: 0, width: 1280, height: 1400 },
    moved: [
      ['under', { x: 0, y: 1640, width: 1280, height: 800 }],
      ['under-under', { x: 1000, y: 2680, width: 1280, height: 800 }],
    ],
  })
  assert.deepEqual(growDown(rect, 600, others), { rect: { x: 0, y: 0, width: 1280, height: 600 }, moved: [] }, 'a shrink moves nothing')
  assert.deepEqual(growDown(rect, 99999, []).rect, { x: 0, y: 0, width: 1280, height: 12000 })
})
