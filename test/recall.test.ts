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
  recallOwns,
  recallStep,
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

/** The box after an arrow put `body` in it. */
const showing = (at: number, body: DraftNode[]): RecallState => ({ at, shown: draftKey(body) })

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

test('an empty box or one still showing a recalled message is the history’s', () => {
  const [newest] = recallHistory([sent('newest')])
  assert.equal(recallOwns(RECALL_START, []), true)
  assert.equal(recallOwns(RECALL_START, [{ t: 'text', v: '  \n' }]), true)
  assert.equal(recallOwns(showing(0, newest!), newest!), true)
})

// The one thing the arrows must never do: throw away what the user is writing.
test('a draft of the user’s own, or a recalled message typed over, keeps its arrows', () => {
  const [newest] = recallHistory([sent('newest')])
  const typed: DraftNode[] = [{ t: 'text', v: 'half a thought' }]
  assert.equal(recallOwns(RECALL_START, typed), false)
  const edited: DraftNode[] = [...newest!, { t: 'text', v: ' more' }]
  assert.equal(recallOwns(showing(0, newest!), edited), false)
})

test('Up walks back to the oldest and stops there, Down walks forward to an empty box', () => {
  const history = recallHistory([sent('third'), sent('second'), sent('first')])
  let state: RecallState = RECALL_START
  let box: DraftNode[] = []
  const press = (key: 'up' | 'down'): number | null => {
    const next = recallStep(state, box, key, history.length)
    if (next === null) return null
    box = next < 0 ? [] : history[next]!
    state = next < 0 ? RECALL_START : showing(next, box)
    return next
  }
  assert.equal(press('down'), null, 'nothing below the user’s own box')
  assert.deepEqual([press('up'), press('up'), press('up')], [0, 1, 2])
  assert.equal(textOf(box), 'first')
  assert.equal(press('up'), null, 'nothing older than the oldest')
  assert.deepEqual([press('down'), press('down'), press('down')], [1, 0, -1])
  assert.deepEqual(box, [])
  assert.equal(press('down'), null)
})

test('a recalled message emptied by hand starts the walk over from the newest', () => {
  const history = recallHistory([sent('newest'), sent('older')])
  assert.equal(recallStep(showing(1, history[1]!), [], 'up', history.length), 0)
})

test('with nothing sent there is nowhere to go', () => {
  assert.equal(recallStep(RECALL_START, [], 'up', 0), null)
  assert.equal(isBlankDraft([]), true)
})
