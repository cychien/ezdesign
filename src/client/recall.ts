/** The note box's Up and Down arrows, the way Claude Code's composer has them:
 *  walk back through what was sent, and forward again to what you were writing.
 *
 *  Nothing the user wrote is lost to an arrow. Whatever is in the box when the
 *  walk leaves it - a draft, or a recalled message typed over - is held, and the
 *  last Down puts it back. Which presses are the history's and which move the
 *  caret through a long message is the caller's to judge, from where the caret
 *  is; `showingRecalled` is the one case where the caret does not matter. */

import type { SentNoteWire } from '../protocol.js'
import { type DraftNode, type NumberedRef, bodyFromComment } from './draft.js'

/** Where the arrows stand. `at` is the position in the history the box shows,
 *  newest first, or -1 for the user's own box. `shown` is that entry as the box
 *  holds it, which is how a box still untouched since is told from one typed in.
 *  `draft` is what the walk took the box from, for the last Down to give back. */
export interface RecallState {
  at: number
  shown: string | null
  draft: DraftNode[] | null
}

export const RECALL_START: RecallState = { at: -1, shown: null, draft: null }

/** Sent messages as boxes to restore, newest first. One sent twice in a row is
 *  one stop on the way back, not two. */
export function recallHistory(notes: SentNoteWire[]): DraftNode[][] {
  const out: DraftNode[][] = []
  let last: string | null = null
  for (const sent of notes) {
    const body = trimEnd(
      bodyFromComment(sent.note, sent.references as NumberedRef[], sent.attachments, sent.skills),
    )
    const key = draftKey(body)
    if (key === last) continue
    last = key
    out.push(body)
  }
  return out
}

/** Without the space `bodyFromComment` leaves after the last node: the caret
 *  goes straight after the last word, the way the message was typed. A box that
 *  ends on a chip gets its spacer back from `restore`. */
function trimEnd(body: DraftNode[]): DraftNode[] {
  const last = body[body.length - 1]
  if (last?.t !== 'text') return body
  const v = last.v.replace(/[\s ]+$/, '')
  return v ? [...body.slice(0, -1), { t: 'text', v }] : body.slice(0, -1)
}

export function draftKey(body: DraftNode[]): string {
  return JSON.stringify(body)
}

export function isBlankDraft(body: DraftNode[]): boolean {
  return body.every((node) => node.t === 'text' && !node.v.trim())
}

/** Whether the box still shows exactly what an arrow last put there. Then both
 *  arrows are the history's wherever the caret is: nothing in the box is the
 *  user's for them to move through. */
export function showingRecalled(state: RecallState, box: DraftNode[]): boolean {
  return state.at >= 0 && draftKey(box) === state.shown
}

/** Where an arrow takes the box: the state after it and what to fill the box
 *  with, or null when it goes nowhere - Up past the oldest, or Down on the
 *  user's own box. A position in the history comes back with `shown` unset: the
 *  box once filled is the only honest record of what it looks like. */
export function recallMove(
  state: RecallState,
  box: DraftNode[],
  key: 'up' | 'down',
  history: DraftNode[][],
): { state: RecallState; body: DraftNode[] } | null {
  const next = state.at + (key === 'up' ? 1 : -1)
  if (next < -1 || next >= history.length) return null
  // A box that is not exactly what the walk put there is the user's, and what
  // the last Down returns to - in place of anything held before it.
  const draft = showingRecalled(state, box) ? state.draft : box
  if (next === -1) return { state: RECALL_START, body: draft ?? [] }
  return { state: { at: next, shown: null, draft }, body: history[next]! }
}
