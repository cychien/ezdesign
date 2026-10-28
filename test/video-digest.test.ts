import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { MAX_DIGEST_BYTES, MAX_SHEET_BYTES, parseVideoSettle } from '../src/attachment-wire.js'
import { type Clip, planDigest } from '../src/client/video-digest/plan.js'
import { type CellBox, type FrameChange, changedRegions, signatureGrid } from '../src/client/video-digest/signature.js'
import { toAgentAttachment } from '../src/label.js'
import type { Attachment } from '../src/protocol.js'
import { FILES } from './helpers/files.js'

const FRAME_US = 16_667
const grid = signatureGrid({ width: 1920, height: 1080 })

function clip(count: number, changes: (i: number) => CellBox[], times?: (i: number) => number): Clip {
  const at = times ?? ((i: number) => i * FRAME_US)
  const frames: FrameChange[] = Array.from({ length: count }, (_, i) => ({ t: at(i), regions: i === 0 ? [] : changes(i) }))
  return { width: 1920, height: 1080, grid, frames, durationUs: at(count - 1) }
}

const box = (x0: number, y0: number, x1: number, y1: number): CellBox => ({ x0, y0, x1, y1 })
const TOAST = box(20, 14, 26, 16)
const toastAt = (first: number) => (i: number) => (i >= first && i < first + 12 ? [TOAST] : [])

test('the analysed grid of a 1080p frame is 256 x 144, in 8 px cells', () => {
  assert.deepEqual(grid, { width: 256, height: 144, cols: 32, rows: 18, scaleX: 60, scaleY: 60 })
})

test('compression noise under the pixel threshold changes no cell', () => {
  const prev = new Uint8ClampedArray(grid.width * grid.height * 4).fill(100)
  const next = prev.map((v, i) => (i % 4 === 3 ? v : v + (i % 13)))
  assert.deepEqual(changedRegions(prev, next, grid), [])
})

test('two separate changes in one frame come back as two regions', () => {
  const prev = new Uint8ClampedArray(grid.width * grid.height * 4)
  const next = prev.slice()
  const paint = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) next[(y * grid.width + x) * 4] = 255
  }
  paint(0, 0, 16, 8)
  paint(200, 100, 8, 16)
  assert.deepEqual(changedRegions(prev, next, grid), [box(0, 0, 1, 0), box(25, 12, 25, 14)])
})

test('a 200 ms toast at 60 fps gets a sheet of its own with the frame before and all 12 changed frames', () => {
  const plan = planDigest(clip(180, toastAt(73)))
  assert.equal(plan.sheets.length, 2)
  assert.deepEqual(plan.motion, [
    { fromMs: 1200, toMs: 1400, region: { x: 1140, y: 780, width: 540, height: 300 }, frames: 12, shown: 12, sheet: 2 },
  ])
  const cells = plan.sheets[1]!.cells
  assert.equal(cells.length, 13)
  assert.equal(cells[0]!.label, '1.200 s · before')
  assert.equal(cells[1]!.label, '1.217 s')
  assert.match(plan.sheets[1]!.header, /^sheet 2 · motion 1\.200-1\.400 s · x 1140 y 780, 540x300 · every changed frame \(12\)$/)
})

test('the toast sheet is cropped to the toast, padded a cell, not to the whole frame', () => {
  const plan = planDigest(clip(180, toastAt(73)))
  for (const cell of plan.sheets[1]!.cells) assert.deepEqual(cell.src, { x: 1140, y: 780, width: 540, height: 300 })
  for (const cell of plan.sheets[0]!.cells) assert.deepEqual(cell.src, { x: 0, y: 0, width: 1920, height: 1080 })
})

test('the overview holds the first and last frames and the settled toast, outlined with its sheet number', () => {
  const plan = planDigest(clip(180, toastAt(73)))
  const overview = plan.sheets[0]!
  assert.deepEqual(overview.cells.map((c) => c.label), ['0.000 s', '1.400 s', '2.983 s'])
  assert.deepEqual(overview.cells[1]!.marks.map((m) => m.text), ['2'])
  assert.deepEqual(overview.cells[0]!.marks, [])
})

test('a pointer travelling across a still page gets no motion sheet, and the overview shows where it stopped', () => {
  const plan = planDigest(clip(120, (i) => (i >= 10 && i < 40 ? [box(i - 10, 5, i - 9, 6)] : [])))
  assert.deepEqual(plan.motion, [])
  assert.equal(plan.sheets.length, 1)
  assert.deepEqual(plan.sheets[0]!.cells.map((c) => c.label), ['0.000 s', '0.650 s', '1.983 s'])
})

test('a hover fade under a resting pointer is an event, not pointer travel', () => {
  const plan = planDigest(clip(120, (i) => (i >= 10 && i < 22 ? [box(4, 4, 5, 5)] : [])))
  assert.equal(plan.motion.length, 1)
  assert.equal(plan.motion[0]!.sheet, 2)
})

test('a toast while the pointer moves elsewhere is two episodes, and only the toast is motion', () => {
  const pointer = (i: number) => (i >= 60 && i < 100 ? [box(i - 60, 2, i - 59, 3)] : [])
  const plan = planDigest(clip(180, (i) => [...pointer(i), ...toastAt(73)(i)]))
  assert.equal(plan.motion.length, 1)
  assert.deepEqual(plan.motion[0]!.region, { x: 1140, y: 780, width: 540, height: 300 })
})

test('a looping video in the page is ambient and loses its sheet to any event', () => {
  const corners = [box(1, 1, 3, 3), box(10, 1, 12, 3), box(1, 10, 3, 12), box(28, 1, 30, 3), box(28, 10, 30, 12)]
  const events = (i: number) => corners.flatMap((b, k) => (i >= 20 + k * 30 && i < 32 + k * 30 ? [b] : []))
  const loop = (i: number) => [box(14, 6, 18, 9)].filter(() => i % 2 === 0)
  const plan = planDigest(clip(240, (i) => [...events(i), ...loop(i)]))
  assert.equal(plan.sheets.length, 6)
  const ambient = plan.motion.find((m) => m.frames > 100)!
  assert.equal(ambient.sheet, null)
  assert.equal(ambient.shown, 0)
})

test('a 60 s clip that never stops changing yields at most 6 sheets and 24 cells each, first and last frames kept', () => {
  const plan = planDigest(clip(3600, () => [box(0, 0, 31, 17)]))
  assert.ok(plan.sheets.length <= 6)
  for (const sheet of plan.sheets.slice(1)) assert.ok(sheet.cells.length <= 24)
  const motionCells = plan.sheets[1]!.cells
  assert.equal(motionCells[0]!.label, '0.000 s · before')
  assert.equal(motionCells.at(-1)!.t, 3599 * FRAME_US)
})

test('a long transition is sampled evenly in time and reports shown < frames', () => {
  const plan = planDigest(clip(180, (i) => (i >= 50 && i < 110 ? [TOAST] : [])))
  assert.equal(plan.motion[0]!.frames, 60)
  assert.equal(plan.motion[0]!.shown, 23)
  assert.match(plan.sheets[1]!.header, /23 of 60 changed frames, evenly spaced$/)
})

test('a variable-rate recording is planned by timestamps, not frame counts', () => {
  const times = (i: number) => (i < 40 ? i * FRAME_US : 40 * FRAME_US + (i - 40) * 100_000)
  const plan = planDigest(clip(140, (i) => (i >= 20 ? [TOAST] : []), times))
  const t = plan.sheets[1]!.cells.slice(1).map((c) => c.t)
  const gaps = t.slice(1).map((x, i) => x - t[i]!)
  assert.ok(Math.max(...gaps) < 4 * Math.min(...gaps.filter((g) => g > FRAME_US)), `uneven gaps ${gaps}`)
})

test('no sheet is larger than 1568 px on its long side, and a tiny region is scaled up by a whole number', () => {
  const plan = planDigest(clip(180, (i) => (i >= 50 && i < 56 ? [box(10, 10, 10, 10)] : [])))
  for (const sheet of plan.sheets) assert.ok(Math.max(sheet.width, sheet.height) <= 1568)
  const tiny = plan.sheets[1]!.cells[0]!
  assert.equal(tiny.pixelated, true)
  assert.equal(tiny.dst.width / tiny.src.width, 2)
})

test('the same clip plans the same way twice', () => {
  assert.deepEqual(planDigest(clip(180, toastAt(73))), planDigest(clip(180, toastAt(73))))
})

test('every timestamp a sheet draws is asked of the second decode, once and in order', () => {
  const plan = planDigest(clip(180, toastAt(73)))
  const drawn = [...new Set(plan.sheets.flatMap((s) => s.cells.map((c) => c.t)))].sort((a, b) => a - b)
  assert.deepEqual(plan.wanted, drawn)
})

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64')
const settle = (overrides: Record<string, unknown> = {}) => ({
  state: 'ready',
  durationMs: 3000,
  width: 1920,
  height: 1080,
  fps: 60,
  audio: false,
  motion: [{ fromMs: 1200, toMs: 1400, region: { x: 1140, y: 780, width: 540, height: 300 }, frames: 12, shown: 12, sheet: 2 }],
  sheets: [JPEG, JPEG],
  ...overrides,
})

test('parseVideoSettle takes a well-formed digest and hands back its sheets as bytes', () => {
  const parsed = parseVideoSettle(settle())
  assert.ok(typeof parsed !== 'string' && parsed.state === 'ready')
  assert.deepEqual([...parsed.sheets[0]!], [0xff, 0xd8, 0xff, 0xe0, 0, 16])
})

test('parseVideoSettle refuses a sheet that is not a JPEG, too many sheets, and a stretch pointing at no sheet', () => {
  assert.equal(parseVideoSettle(settle({ sheets: [Buffer.from('PNG').toString('base64'), JPEG] })), 'a sheet must be a JPEG')
  assert.equal(parseVideoSettle(settle({ sheets: Array(7).fill(JPEG) })), 'sheets must hold 1 to 6 images')
  assert.equal(parseVideoSettle(settle({ sheets: [JPEG] })), 'a stretch names a sheet that is not there')
  assert.equal(parseVideoSettle(settle({ sheets: [JPEG, JPEG, JPEG] })), 'every sheet past the first belongs to a stretch')
  assert.equal(
    parseVideoSettle(settle({ motion: [{ ...settle().motion[0], region: { x: 1800, y: 0, width: 540, height: 240 } }] })),
    'a stretch region must lie inside the frame',
  )
  assert.equal(parseVideoSettle({ state: 'failed', reason: 'bored', detail: '' }), 'unknown failure reason')
})

test('parseVideoSettle refuses sheets that together pass the digest cap', () => {
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_SHEET_BYTES - 3)]).toString('base64')
  assert.ok(3 * MAX_SHEET_BYTES > MAX_DIGEST_BYTES)
  const motion = [2, 3].map((sheet, i) => ({ ...settle().motion[0], fromMs: 1200 + i, sheet }))
  assert.equal(parseVideoSettle(settle({ sheets: [big, big, big], motion })), 'the sheets together are too large')
})

const video: Attachment = { id: 'a1b2c3d4e5f6', name: 'rec.mov', mime: 'video/quicktime', size: 10, createdAt: 1 }

test('a ready video reaches the agent with how to read it and the paths of its sheets', () => {
  const agent = toAgentAttachment(
    {
      ...video,
      video: {
        state: 'ready',
        durationMs: 3000,
        width: 1920,
        height: 1080,
        fps: 60,
        audio: true,
        motion: [{ fromMs: 1200, toMs: 1400, region: { x: 1140, y: 780, width: 540, height: 300 }, frames: 12, shown: 12, sheet: 2 }],
      },
    },
    FILES,
  )
  assert.ok(agent.video && 'overview' in agent.video)
  assert.equal(agent.video.overview, '/tmp/session/attachments/a1b2c3d4e5f6.sheet-1.jpg')
  assert.deepEqual(agent.video.motion, [
    { from: 1.2, to: 1.4, region: { x: 1140, y: 780, width: 540, height: 300 }, frames: 12, shown: 12, sheet: '/tmp/session/attachments/a1b2c3d4e5f6.sheet-2.jpg' },
  ])
  assert.match(agent.video.read, /^A recording you cannot open: do not read `path`\./)
  assert.match(agent.video.read, /It has sound you cannot hear/)
})

test('a video without frames tells the agent why, and a pending one is never projected', () => {
  const failed = toAgentAttachment({ ...video, video: { state: 'failed', reason: 'unsupported-codec', detail: 'hvc1' } }, FILES)
  assert.deepEqual(failed.video, {
    read:
      'No frames could be taken from this video: that browser cannot decode its codec (hvc1). ' +
      'Do not try to read `path`. Tell the user, and ask them what it shows.',
    unreadable: 'unsupported-codec',
  })
  assert.equal(toAgentAttachment({ ...video, video: { state: 'pending' } }, FILES).video, undefined)
})

test('dist/video-digest.js is a build target and in the daemon\'s asset list, as every client target is', () => {
  const build = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8')
  const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8')
  const targets = [...build.matchAll(/outfile: 'dist\/([\w-]+\.(?:js|css))'/g)].map((m) => m[1]!)
  const served = /for \(const file of \[([^\]]+)\]\)/.exec(daemon)![1]!.match(/'([^']+)'/g)!.map((s) => s.slice(1, -1))
  assert.ok(targets.includes('video-digest.js'))
  for (const file of served) assert.ok(targets.includes(file), `${file} is served but never built`)
  for (const file of targets.filter((t) => !t.endsWith('.mjs'))) assert.ok(served.includes(file), `${file} is built but never served`)
})
