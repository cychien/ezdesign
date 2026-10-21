import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GUEST_PROTOCOL,
  type GuestKind,
  type Sender,
  type ShellToGuestType,
  parseGuestMessage,
  receives,
} from '../src/client/guest-messages.js'

const APP: Sender = { kind: 'app' }
const CANVAS: Sender = { kind: 'canvas', place: { canvasId: 'c1', frameId: 'f1' } }

const anchor = { selector: 'h1', source: 'src/App.tsx:3' }

/** One well-formed message per guest-to-shell type. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  'ez:ready': { page: '/', url: '/?a=1' },
  'ez:page': { url: '/pricing' },
  'ez:navigate': { url: '/pricing' },
  'ez:mode': { mode: 'element' },
  'ez:popup': { open: true },
  'ez:pick-armed': { pickId: 'p1', host: 'note' },
  'ez:draft': { pickId: 'p1', draft: { comment: '' } },
  'ez:picked': { pickId: 'p1', ref: { anchor, label: 'h1' }, page: '/' },
  'ez:draft-done': { pickId: 'p1' },
  'ez:draft-expired': { pickId: 'p1' },
  'ez:pick-cancelled': { pickId: 'p1', resumed: true },
  'ez:explore': { anchor, capture: { html: '<h1/>' }, direction: 'bolder' },
  'ez:explore-held': { draft: { comment: 'x' } },
  'ez:key': { chord: { key: 'Enter', metaKey: true, ctrlKey: false } },
  'ez:wheel': { dx: 1, dy: 2 },
  'ez:scroll': { ratio: 0.5 },
  'ez:relay': { reqId: 'r1', op: { op: 'discard-upload', id: 'a1' } },
}

const upTypes = Object.entries(GUEST_PROTOCOL)
  .filter(([, entry]) => entry.dir === 'up')
  .map(([type, entry]) => ({ type, from: (entry as { from: readonly GuestKind[] }).from }))

test('CV-p3-protocol-table: every guest-to-shell type has a sample here', () => {
  assert.deepEqual(upTypes.map((t) => t.type).sort(), Object.keys(SAMPLES).sort())
})

test('CV-p3-protocol-table: a type parses exactly from the kinds the table lets send it', () => {
  for (const { type, from } of upTypes) {
    for (const sender of [APP, CANVAS]) {
      const parsed = parseGuestMessage({ type, ...SAMPLES[type] }, sender)
      assert.equal(parsed !== null, from.includes(sender.kind), `${type} from ${sender.kind}`)
      if (parsed) assert.equal(parsed.type, type)
    }
  }
})

test('CV-p3-protocol-table: a canvas guest cannot navigate or explore, and its keys are marked as coming from a canvas', () => {
  for (const type of ['ez:navigate', 'ez:page', 'ez:explore', 'ez:explore-held', 'ez:scroll']) {
    assert.equal(parseGuestMessage({ type, ...SAMPLES[type] }, CANVAS), null, type)
  }
  assert.deepEqual(parseGuestMessage({ type: 'ez:key', ...SAMPLES['ez:key'] }, CANVAS), {
    type: 'ez:key',
    chord: { key: 'Enter', metaKey: true, ctrlKey: false },
    guest: 'canvas',
  })
})

test('CV-p3-protocol-table: an unknown or shell-to-guest type, or malformed data, is refused', () => {
  assert.equal(parseGuestMessage({ type: 'ez:unknown' }, APP), null)
  assert.equal(parseGuestMessage({ type: 'ez:set-mode', mode: 'off' }, APP), null)
  assert.equal(parseGuestMessage({ type: 'toString' }, APP), null)
  assert.equal(parseGuestMessage({ type: 'ez:mode', mode: 'everything' }, APP), null)
  assert.equal(parseGuestMessage({ type: 'ez:picked', pickId: 'p1' }, APP), null)
  assert.equal(parseGuestMessage('ez:ready', APP), null)
  assert.equal(parseGuestMessage(null, APP), null)
})

test('CV-p3-protocol-table: a picked anchor is attributed to its sender, whatever it claims', () => {
  const claimed = { ...anchor, frame: { canvasId: 'x', frameId: 'y' } }
  const fromApp = parseGuestMessage(
    { type: 'ez:picked', pickId: 'p1', ref: { anchor: claimed, label: 'h1' } },
    APP,
  )
  assert.deepEqual(fromApp, { type: 'ez:picked', pickId: 'p1', ref: { anchor, label: 'h1' }, page: '/' })
  const fromCanvas = parseGuestMessage(
    { type: 'ez:picked', pickId: 'p1', ref: { anchor: claimed, label: 'h1' } },
    CANVAS,
  )
  assert.deepEqual(fromCanvas, {
    type: 'ez:picked',
    pickId: 'p1',
    ref: { anchor: { ...anchor, frame: { canvasId: 'c1', frameId: 'f1' } }, label: 'h1' },
    page: '/',
  })
})

test('CV-p3-protocol-table: a relayed annotation is attributed and a bad relay op refused', () => {
  const relayed = parseGuestMessage(
    { type: 'ez:relay', reqId: 'r2', op: { op: 'annotate', body: { comment: 'x', anchor: { ...anchor, frame: { canvasId: 'z', frameId: 'z' } } } } },
    CANVAS,
  )
  assert.deepEqual(relayed, {
    type: 'ez:relay',
    reqId: 'r2',
    op: { op: 'annotate', body: { comment: 'x', anchor: { ...anchor, frame: { canvasId: 'c1', frameId: 'f1' } } } },
  })
  const bytes = new ArrayBuffer(3)
  assert.deepEqual(
    parseGuestMessage({ type: 'ez:relay', reqId: 'r3', op: { op: 'upload', name: 'a.png', mime: 'image/png', bytes } }, CANVAS),
    { type: 'ez:relay', reqId: 'r3', op: { op: 'upload', name: 'a.png', mime: 'image/png', bytes } },
  )
  assert.equal(parseGuestMessage({ type: 'ez:relay', reqId: 'r4', op: { op: 'upload', name: 'a', mime: 'b', bytes: 'nope' } }, CANVAS), null)
  assert.equal(parseGuestMessage({ type: 'ez:relay', reqId: 'r5', op: { op: 'send' } }, CANVAS), null)
})

test('CV-p3-protocol-table: receives agrees with the table for every shell-to-guest type', () => {
  const downs = Object.entries(GUEST_PROTOCOL).filter(([, e]) => e.dir === 'down')
  assert.ok(downs.length > 0)
  for (const [type, entry] of downs) {
    const to = (entry as { to: readonly GuestKind[] }).to
    for (const kind of ['app', 'canvas'] as const) {
      assert.equal(receives(kind, type as ShellToGuestType), to.includes(kind), `${type} to ${kind}`)
    }
  }
  assert.equal(receives('canvas', 'ez:variant'), false)
  assert.equal(receives('app', 'ez:relay-done'), false)
  assert.equal(receives('app', 'ez:snapshot'), true)
  assert.equal(receives('canvas', 'ez:set-mode'), true)
})
