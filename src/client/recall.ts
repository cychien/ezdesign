/** The note box's Up and Down arrows, the way Claude Code's and Codex's
 *  composers have them: walk back through what was sent, and forward again.
 *
 *  The arrows only ever belong to the history while the box holds nothing of
 *  the user's own - it is empty, or it still shows exactly what an arrow put
 *  there. Anything typed over a recalled message makes it a draft, and from then
 *  on the arrows move the caret like anywhere else: a draft is never replaced by
 *  a key press. */

import type { SentNoteWire } from '../protocol.js'
import { type DraftNode, type NumberedRef, bodyFromComment } from './draft.js'

/** Where the arrows stand: `at` is the position in the history the box shows,
 *  newest first, or -1 for the user's own box. `shown` is that entry as the box
 *  holds it, which is how a box still untouched since is told from one typed in. */
export interface RecallState {
  at: number
  shown: string | null
}

export const RECALL_START: RecallState = { at: -1, shown: null }

/** Sent messages as boxes to restore, newest first. One sent twice in a row is
 *  one stop on the way back, not two. */
export function recallHistory(notes: SentNoteWire[]): DraftNode[][] {
  const out: DraftNode[][] = []
  let last: string | null = null
  for (const sent of notes) {
    const body = bodyFromComment(
      sent.note,
      sent.references as NumberedRef[],
      sent.attachments,
      sent.skills,
    )
    const trimmed = trimEnd(body)
    const key = draftKey(trimmed)
    if (key === last) continue
    last = key
    out.push(trimmed)
  }
  return out
}

/** Without the space `bodyFromComment` leaves after the last node: the caret
 *  goes straight after the last word, the way the message was typed. A box that
 *  ends on a chip gets its spacer back from `restore`. */
function trimEnd(body: DraftNode[]): DraftNode[] {
  const last = body[body.length - 1]
  if (last?.t !== 'text') return body
  const v = last.v.replace(/[\s\u00a0]+$/, '')
  return v ? [...body.slice(0, -1), { t: 'text', v }] : body.slice(0, -1)
}

export function draftKey(body: DraftNode[]): string {
  return JSON.stringify(body)
}

export function isBlankDraft(body: DraftNode[]): boolean {
  return body.every((node) => node.t === 'text' && !node.v.trim())
}

/** Whether the box still shows exactly what an arrow last put there. */
function showingRecalled(state: RecallState, box: DraftNode[]): boolean {
  return state.at >= 0 && draftKey(box) === state.shown
}

/** Whether the arrow belongs to the history at all, judged from the box as it
 *  is. When it does, the key is taken even if there is nowhere to move, so the
 *  caret does not jump instead. */
export function recallOwns(state: RecallState, box: DraftNode[]): boolean {
  return isBlankDraft(box) || showingRecalled(state, box)
}

/** The position an arrow moves to, or null when it moves nowhere: Up past the
 *  oldest, or Down on the user's own box. -1 is the user's own, empty box. */
export function recallStep(
  state: RecallState,
  box: DraftNode[],
  key: 'up' | 'down',
  count: number,
): number | null {
  const at = showingRecalled(state, box) ? state.at : -1
  const next = key === 'up' ? at + 1 : at - 1
  return next < -1 || next >= count ? null : next
}
