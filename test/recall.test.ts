import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SentNoteWire } from '../src/protocol.js'
import type { DraftNode } from '../src/client/draft.js'
import {
  RECALL_START,
  type RecallState,
  draftKey,
  isBlankDraft,
  recallHistory,
  recallMove,
  showingRecalled,
} from '../src/client/recall.js'

const sent = (note: string, extra: Partial<SentNoteWire> = {}): SentNoteWire => ({
  note,
  references: [],
  attachments: [],
  skills: [],
  ...extra,
})

/** What the box reads as, without the space `bodyFromComment` leaves after the
 *  last node for the caret. */
const textOf = (body: DraftNode[]): string =>
  body
    .map((n) => (n.t === 'text' ? n.v : `<${n.t}>`))
    .join('')
    .trim()

const typed = (v: string): DraftNode[] => [{ t: 'text', v }]

/** A box and the arrows over it, pressed the way the shell presses them: the
 *  state an arrow returns is completed with what the box then holds. */
function walker(history: DraftNode[][], start: DraftNode[] = []) {
  let state: RecallState = RECALL_START
  let box = start
  return {
    press(key: 'up' | 'down'): boolean {
      const move = recallMove(state, box, key, history)
      if (!move) return false
      box = move.body
      state = move.state.at < 0 ? move.state : { ...move.state, shown: draftKey(box) }
      return true
    },
    type(more: string) {
      box = [...box, { t: 'text', v: more }]
    },
    get box() {
      return box
    },
    get state() {
      return state
    },
  }
}

test('a sent message comes back with its chips where the markers were', () => {
  const [body] = recallHistory([
    sent('改成像 [ref 1] 那樣，參考 [file 1]，用 [skill 1]', {
      references: [{ n: 1, anchor: { source: 'src/Hero.tsx:12' }, label: 'h1' }],
      attachments: [{ id: 'f1', name: 'shot.png' }],
      skills: ['polish'],
    }),
  ])
  assert.deepEqual(
    body!.filter((n) => n.t !== 'text').map((n) => n.t),
    ['ref', 'file', 'skill'],
  )
  assert.match(textOf(body!), /^改成像 <ref> 那樣，參考 <file>，用 <skill>/)
  const ref = body!.find((n) => n.t === 'ref')
  assert.deepEqual(ref && ref.t === 'ref' ? ref.anchor : null, { source: 'src/Hero.tsx:12' })
})

test('a recalled message ends where its last word does, so typing carries straight on', () => {
  const [plain, chipped] = recallHistory([
    sent('標題改大'),
    sent('像 [ref 1]', { references: [{ n: 1, anchor: { source: 'a.tsx:1' }, label: 'h1' }] }),
  ])
  assert.deepEqual(plain, [{ t: 'text', v: '標題改大' }])
  assert.equal(chipped!.at(-1)!.t, 'ref', 'restore gives a box ending on a chip its own spacer')
})

test('the same message sent twice in a row is one step back, not two', () => {
  const history = recallHistory([sent('again'), sent('again'), sent('before'), sent('again')])
  assert.deepEqual(history.map(textOf), ['again', 'before', 'again'])
})

test('Up walks back to the oldest and stops there, Down walks forward to an empty box', () => {
  const w = walker(recallHistory([sent('third'), sent('second'), sent('first')]))
  assert.equal(w.press('down'), false, 'nothing below the user’s own box')
  const back = [w.press('up'), textOf(w.box), w.press('up'), textOf(w.box), w.press('up'), textOf(w.box)]
  assert.deepEqual(back, [true, 'third', true, 'second', true, 'first'])
  assert.equal(w.press('up'), false, 'nothing older than the oldest')
  const forward = [w.press('down'), textOf(w.box), w.press('down'), textOf(w.box), w.press('down')]
  assert.deepEqual(forward, [true, 'second', true, 'third', true])
  assert.deepEqual(w.box, [])
  assert.equal(w.press('down'), false)
})

// The point of the change: a half-written message is not in the way of the
// history, and is still there at the end of the walk.
test('a draft is held while Up walks the history, and the last Down gives it back', () => {
  const w = walker(recallHistory([sent('newest'), sent('older')]), typed('寫到一半'))
  assert.equal(w.press('up'), true)
  assert.equal(textOf(w.box), 'newest')
  w.press('up')
  w.press('down')
  w.press('down')
  assert.deepEqual(w.box, typed('寫到一半'))
  assert.deepEqual(w.state, RECALL_START)
})

test('a recalled message typed over is what the last Down returns to', () => {
  const w = walker(recallHistory([sent('newest'), sent('older')]), typed('原本的草稿'))
  w.press('up')
  w.press('up')
  w.type('，改過')
  assert.equal(showingRecalled(w.state, w.box), false, 'typed over, it is the user’s now')
  assert.equal(w.press('down'), true)
  assert.equal(textOf(w.box), 'newest')
  w.press('down')
  assert.equal(textOf(w.box), 'older，改過')
})

test('a recalled message untouched is still the history’s, wherever the caret is', () => {
  const w = walker(recallHistory([sent('newest')]))
  w.press('up')
  assert.equal(showingRecalled(w.state, w.box), true)
  assert.equal(showingRecalled(RECALL_START, w.box), false)
})

test('with nothing sent there is nowhere to go, and the box is left alone', () => {
  const w = walker([], typed('draft'))
  assert.equal(w.press('up'), false)
  assert.deepEqual(w.box, typed('draft'))
  assert.equal(isBlankDraft([]), true)
  assert.equal(isBlankDraft([{ t: 'text', v: ' \u00a0\n' }]), true)
})
