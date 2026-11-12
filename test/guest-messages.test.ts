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
  'ez:recaptured': { reqId: 'r1', capture: { html: '<h1/>' } },
  'ez:key': { chord: { key: 'Enter', code: 'Enter', metaKey: true, ctrlKey: false } },
  'ez:wheel': { dx: 1, dy: 2 },
  'ez:sweep-start': { from: { x: 1, y: 2 } },
  'ez:sweep-stop': {},
  'ez:scroll': { ratio: 0.5 },
  'ez:relay': { reqId: 'r1', op: { op: 'discard-upload', id: 'a1' } },
  'ez:library-pick': { reqId: 'l1' },
  'ez:share': { purpose: 'compose', anchor, lines: ['h1 · src/App.tsx:3'] },
  'ez:shift-released': {},
  'ez:pointer-here': {},
  'ez:skills-request': { reqId: 'k1' },
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
  for (const type of ['ez:navigate', 'ez:page', 'ez:explore', 'ez:explore-held', 'ez:recaptured', 'ez:scroll']) {
    assert.equal(parseGuestMessage({ type, ...SAMPLES[type] }, CANVAS), null, type)
  }
  assert.deepEqual(parseGuestMessage({ type: 'ez:key', ...SAMPLES['ez:key'] }, CANVAS), {
    type: 'ez:key',
    chord: { key: 'Enter', code: 'Enter', metaKey: true, ctrlKey: false },
    guest: 'canvas',
  })
})

test('CV-p3-protocol-table: an unknown or shell-to-guest type, or malformed data, is refused', () => {
  assert.equal(parseGuestMessage({ type: 'ez:unknown' }, APP), null)
  assert.equal(parseGuestMessage({ type: 'ez:set-mode', mode: 'off' }, APP), null)
  assert.equal(parseGuestMessage({ type: 'toString' }, APP), null)
  assert.equal(parseGuestMessage({ type: 'ez:mode', mode: 'everything' }, APP), null)
  assert.equal(parseGuestMessage({ type: 'ez:picked', pickId: 'p1' }, APP), null)
  assert.equal(parseGuestMessage({ type: 'ez:library-pick', reqId: 7 }, CANVAS), null)
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
  const file = new Blob([new Uint8Array(3)])
  assert.deepEqual(
    parseGuestMessage({ type: 'ez:relay', reqId: 'r3', op: { op: 'upload', name: 'a.png', mime: 'image/png', file } }, CANVAS),
    { type: 'ez:relay', reqId: 'r3', op: { op: 'upload', name: 'a.png', mime: 'image/png', file } },
  )
  assert.equal(parseGuestMessage({ type: 'ez:relay', reqId: 'r4', op: { op: 'upload', name: 'a', mime: 'b', file: 'nope' } }, CANVAS), null)
  assert.equal(parseGuestMessage({ type: 'ez:relay', reqId: 'r5', op: { op: 'send' } }, CANVAS), null)
})

test('whole frames survive only on the sender\'s canvas and with the sender among them', () => {
  const relay = (frames: unknown, sender: Sender) =>
    parseGuestMessage({ type: 'ez:relay', reqId: 'r', op: { op: 'annotate', body: { anchor: { frames } } } }, sender)
  const anchorOf = (m: ReturnType<typeof relay>) => (m?.type === 'ez:relay' && m.op.op === 'annotate' ? m.op.body.anchor : null)
  const own = { canvasId: 'c1', frameId: 'f1' }
  const sibling = { canvasId: 'c1', frameId: 'f2' }
  assert.deepEqual(anchorOf(relay([own, sibling, sibling], CANVAS)), { frame: own, frames: [own, sibling] })
  assert.deepEqual(anchorOf(relay([sibling], CANVAS)), { frame: own })
  assert.deepEqual(anchorOf(relay([own, { canvasId: 'c2', frameId: 'f9' }], CANVAS)), { frame: own })
  assert.deepEqual(anchorOf(relay([own, { canvasId: 'c1' }], CANVAS)), { frame: own })
  assert.deepEqual(anchorOf(relay('f1', CANVAS)), { frame: own })
  const picked = parseGuestMessage({ type: 'ez:picked', pickId: 'p', ref: { anchor: { frames: [own] }, label: 'x' } }, APP)
  assert.deepEqual(picked?.type === 'ez:picked' && picked.ref.anchor, {})
})

test('parts survive only on the sender\'s canvas, with the sender among them, one level deep', () => {
  const relay = (parts: unknown, sender: Sender) =>
    parseGuestMessage({ type: 'ez:relay', reqId: 'r', op: { op: 'annotate', body: { anchor: { contains: ['a', 'b'], parts } } } }, sender)
  const anchorOf = (m: ReturnType<typeof relay>) => (m?.type === 'ez:relay' && m.op.op === 'annotate' ? m.op.body.anchor : null)
  const own = { canvasId: 'c1', frameId: 'f1' }
  const sibling = { canvasId: 'c1', frameId: 'f2' }
  const mine = { source: 'f1.html:3', frame: own }
  const theirs = { source: 'f2.html:9', frame: sibling }
  const wholeSibling = { source: 'f2.html', frame: sibling, frames: [sibling] }
  assert.deepEqual(anchorOf(relay([mine, theirs], CANVAS)), { contains: ['a', 'b'], frame: own, parts: [mine, theirs] })
  assert.deepEqual(anchorOf(relay([mine, wholeSibling], CANVAS)), { contains: ['a', 'b'], frame: own, parts: [mine, wholeSibling] })
  // Without the sender, on another canvas, a whole-frame part about another
  // frame than its own, a group of groups, or a lone part: all dropped whole.
  assert.deepEqual(anchorOf(relay([theirs, theirs], CANVAS)), { contains: ['a', 'b'], frame: own })
  assert.deepEqual(anchorOf(relay([mine, { frame: { canvasId: 'c2', frameId: 'f9' } }], CANVAS)), { contains: ['a', 'b'], frame: own })
  assert.deepEqual(anchorOf(relay([mine, { ...theirs, frames: [own] }], CANVAS)), { contains: ['a', 'b'], frame: own })
  assert.deepEqual(anchorOf(relay([mine, { parts: [mine, theirs] }], CANVAS)), { contains: ['a', 'b'], frame: own })
  assert.deepEqual(anchorOf(relay([mine], CANVAS)), { contains: ['a', 'b'], frame: own })
  // An App guest's parts are previews of one page: they name no frame.
  const shared = parseGuestMessage(
    { type: 'ez:share', purpose: 'pick', anchor: { contains: ['a', 'b'], parts: [{ selector: 'h1', frame: own }, { selector: 'p' }] }, lines: ['a', 7] },
    APP,
  )
  assert.deepEqual(shared, {
    type: 'ez:share',
    purpose: 'pick',
    anchor: { contains: ['a', 'b'], parts: [{ selector: 'h1' }, { selector: 'p' }] },
    lines: ['a'],
  })
})

test('a share names its purpose, and an empty one is null', () => {
  assert.deepEqual(parseGuestMessage({ type: 'ez:share', purpose: 'compose', anchor: null }, CANVAS), {
    type: 'ez:share',
    purpose: 'compose',
    anchor: null,
    lines: [],
  })
  assert.equal(parseGuestMessage({ type: 'ez:share', purpose: 'region', anchor: null }, CANVAS), null)
  assert.equal(parseGuestMessage({ type: 'ez:share', purpose: 'pick', anchor: 'h1' }, CANVAS), null)
})

test('a sweep starts at a point given as numbers', () => {
  assert.deepEqual(parseGuestMessage({ type: 'ez:sweep-start', from: { x: 1, y: 2 } }, CANVAS), {
    type: 'ez:sweep-start',
    from: { x: 1, y: 2 },
  })
  assert.equal(parseGuestMessage({ type: 'ez:sweep-start', from: { x: 1 } }, CANVAS), null)
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
