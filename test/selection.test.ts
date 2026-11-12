import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EMPTY,
  type Purpose,
  type SelectionEffect,
  type SelectionEvent,
  type SelectionState,
  compositeAnchor,
  extendable,
  reduceSelection,
} from '../src/client/selection.js'

const A = 'canvas:c1/a'
const B = 'canvas:c1/b'
const M = 'canvas:c1/m'
const h1A = { source: 'a.html:14', frame: { canvasId: 'c1', frameId: 'a' } }
const h1B = { source: 'b.html:17', frame: { canvasId: 'c1', frameId: 'b' } }
const mobile = { canvasId: 'c1', frameId: 'm', file: 'm.html', title: 'Mobile' }
const heroB = { canvasId: 'c1', frameId: 'b', file: 'b.html', title: 'Hero B' }

const share = (source: string, anchor: typeof h1A | null): SelectionEvent => ({
  t: 'share',
  source,
  anchor,
  lines: anchor ? [anchor.source] : [],
})

function run(purpose: Purpose, events: SelectionEvent[], from: SelectionState = EMPTY) {
  let state = from
  let effects: SelectionEffect[] = []
  for (const e of events) {
    const out = reduceSelection(purpose, state, e)
    state = out.state
    effects = out.effects
  }
  return { state, effects }
}

const of = <K extends SelectionEffect['do']>(effects: SelectionEffect[], kind: K) =>
  effects.filter((e): e is Extract<SelectionEffect, { do: K }> => e.do === kind)

test('one document alone is its own: no guest is told, and Shift coming up settles nothing here', () => {
  const { state, effects } = run('compose', [share(A, h1A)])
  assert.deepEqual(of(effects, 'multi'), [])
  assert.deepEqual(reduceSelection('compose', state, { t: 'settle' }).effects, [])
})

test('a second document makes it the shell\'s: both are told, and Shift up opens one composer where the last was added', () => {
  const gathered = run('compose', [share(A, h1A), share(B, h1B)])
  assert.deepEqual(of(gathered.effects, 'multi'), [
    { do: 'multi', source: A, on: true },
    { do: 'multi', source: B, on: true },
  ])
  const settled = reduceSelection('compose', gathered.state, { t: 'settle' })
  const [compose] = of(settled.effects, 'compose')
  assert.equal(compose?.host, B)
  assert.deepEqual(compose?.anchor, { contains: ['a.html:14', 'b.html:17'], parts: [h1A, h1B] })
  // A second Shift up, heard elsewhere, opens nothing more.
  const opened = run('compose', [{ t: 'popup', source: B, open: true }, { t: 'settle' }], settled.state)
  assert.deepEqual(of(opened.effects, 'compose'), [])
})

test('a share into a popup that is about a Shift selection points that popup at all of it', () => {
  const open = run('compose', [{ t: 'popup', source: A, open: true }, share(A, h1A)])
  assert.ok(extendable(open.state))
  const { effects } = run('compose', [share(B, h1B)], open.state)
  assert.deepEqual(of(effects, 'compose'), [
    { do: 'compose', host: A, anchor: { contains: ['a.html:14', 'b.html:17'], parts: [h1A, h1B] }, at: null },
  ])
  // Taking B's member back out hands the popup back to A alone.
  const back = run('compose', [share(B, h1B), share(B, null)], open.state)
  assert.deepEqual(of(back.effects, 'multi'), [
    { do: 'multi', source: A, on: false },
    { do: 'multi', source: B, on: false },
  ])
  assert.deepEqual(of(back.effects, 'compose'), [])
})

test('a popup that is not about a Shift selection hands a share straight back', () => {
  const textPopup = run('compose', [{ t: 'popup', source: A, open: true }])
  assert.equal(extendable(textPopup.state), false)
  const { state, effects } = run('compose', [share(B, h1B)], textPopup.state)
  assert.deepEqual(effects, [{ do: 'end', sources: [B] }])
  assert.deepEqual(state.shares, [])
})

test('whole frames: Shift gathers and outlines them, a plain click settles at once and drops what was gathered', () => {
  const frames = (whole: typeof mobile, add: boolean): SelectionEvent => ({
    t: 'frames',
    frames: [{ whole, source: whole === mobile ? M : B }],
    host: whole === mobile ? M : B,
    at: null,
    add,
  })
  const gathered = run('compose', [frames(mobile, true), frames(heroB, true)])
  assert.deepEqual(of(gathered.effects, 'outline').at(-1), {
    do: 'outline',
    frames: [
      { canvasId: 'c1', frameId: 'm' },
      { canvasId: 'c1', frameId: 'b' },
    ],
  })
  const [compose] = of(reduceSelection('compose', gathered.state, { t: 'settle' }).effects, 'compose')
  assert.deepEqual(compose?.anchor, {
    contains: ['m.html · "Mobile"', 'b.html · "Hero B"'],
    frames: [
      { canvasId: 'c1', frameId: 'm' },
      { canvasId: 'c1', frameId: 'b' },
    ],
  })
  const plain = run('compose', [share(A, h1A), frames(mobile, false)])
  assert.deepEqual(of(plain.effects, 'end'), [{ do: 'end', sources: [A] }])
  assert.deepEqual(of(plain.effects, 'compose')[0]?.anchor, { source: 'm.html', frames: [{ canvasId: 'c1', frameId: 'm' }] })
})

test('a whole frame beside elements is a part of its own, and subsumes what was picked inside it', () => {
  const anchor = compositeAnchor([
    { source: A, anchor: h1A, lines: ['a'], whole: null },
    { source: B, anchor: h1B, lines: ['b'], whole: heroB },
  ])
  assert.deepEqual(anchor, {
    contains: ['a', 'b.html · "Hero B"'],
    parts: [h1A, { source: 'b.html', frame: { canvasId: 'c1', frameId: 'b' }, frames: [{ canvasId: 'c1', frameId: 'b' }] }],
  })
})

test('a pick across documents is chosen as one reference when Shift comes up, and the selection is spent', () => {
  const { state, effects } = run('pick', [share(A, h1A), share(B, h1B), { t: 'settle' }])
  const [choose] = of(effects, 'choose')
  assert.deepEqual(choose?.ref.anchor, { contains: ['a.html:14', 'b.html:17'], parts: [h1A, h1B] })
  assert.equal(choose?.ref.label, '選取 2 項')
  assert.deepEqual(of(effects, 'end'), [{ do: 'end', sources: [A, B] }])
  assert.deepEqual(state.shares, [])
})

test('the popup closing spends the selection, and every member is told', () => {
  const open = run('compose', [share(A, h1A), share(B, h1B), { t: 'settle' }, { t: 'popup', source: B, open: true }])
  const { state, effects } = run('compose', [{ t: 'popup', source: B, open: false }], open.state)
  assert.deepEqual(of(effects, 'end'), [{ do: 'end', sources: [A, B] }])
  assert.deepEqual(state, EMPTY)
  // A close from a frame that holds no popup is nobody's.
  assert.deepEqual(reduceSelection('compose', open.state, { t: 'popup', source: A, open: false }).effects, [])
})

test('an empty share from a document with none is an echo, and says nothing', () => {
  assert.deepEqual(reduceSelection('compose', EMPTY, share(A, null)), { state: EMPTY, effects: [] })
})
