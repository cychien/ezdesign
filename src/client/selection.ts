/** A Shift selection that spans more than one document, as a reducer.
 *
 *  Each overlay owns its own share - the elements and boxes Shift added in its
 *  document - and reports it as one anchor. Inside one document nothing here is
 *  needed: the overlay composes or answers on its own, as it always has. The
 *  moment a second document, or a whole canvas frame chosen by its title, joins
 *  in, the shell owns the selection: one composer for all of it, one reference
 *  for all of it, and one place that hears Shift come up.
 *
 *  Two of these run side by side, one per purpose: a comment's members
 *  (`compose`) and a pick's (`pick`). A pick's members are what the comment
 *  suspended under it is about to point at, and neither may disturb the other.
 *
 *  Pure, so the races between frames - who heard Shift come up, which frame the
 *  composer is open in, a share arriving while a popup is up elsewhere - can be
 *  tested without a DOM. */

import type { AnchorWire, RefWire } from './draft.js'
import { groupLines, shortAnchor } from '../label.js'

export type Purpose = 'compose' | 'pick'

export interface Point {
  x: number
  y: number
}

/** A canvas frame chosen whole by its title, or by a box swept over it. */
export interface WholeFrame {
  canvasId: string
  frameId: string
  file: string
  title: string
}

export interface Share {
  /** The guest whose document this is - for a whole frame, that frame's guest,
   *  mounted or not. */
  source: string
  /** The guest's own members as one anchor, attributed by the parser. */
  anchor: AnchorWire | null
  /** One line per member, as the group's `contains` lists it. */
  lines: string[]
  whole: WholeFrame | null
}

export interface SelectionState {
  /** In the order each document joined, which is the order the group reads. */
  shares: Share[]
  /** The document that last added, and where in it: the composer opens there,
   *  under the user's eye and pointer. */
  last: { source: string; at: Point | null } | null
  /** The guest with an annotation popup open, whatever it is about. */
  popup: string | null
  /** The guest whose popup was handed this selection as its subject. */
  composed: string | null
  /** Guests last told their share is part of something bigger. */
  told: string[]
}

export type SelectionEvent =
  | { t: 'share'; source: string; anchor: AnchorWire | null; lines: string[] }
  /** Whole frames from the board. `add` is Shift: join the selection rather
   *  than settle at once on just these. */
  | { t: 'frames'; frames: { whole: WholeFrame; source: string }[]; host: string; at: Point | null; add: boolean }
  /** Shift came up, wherever it was heard. */
  | { t: 'settle' }
  | { t: 'popup'; source: string; open: boolean }
  | { t: 'reset' }

export type SelectionEffect =
  /** Whether `source` composes or answers on its own when Shift comes up. */
  | { do: 'multi'; source: string; on: boolean }
  /** Open the composer in `host`, or point its open one, at `anchor`. */
  | { do: 'compose'; host: string; anchor: AnchorWire; at: Point | null }
  | { do: 'choose'; ref: RefWire }
  /** These drop their members: the selection is spent or refused. */
  | { do: 'end'; sources: string[] }
  /** The whole frames the board outlines as the selection's. */
  | { do: 'outline'; frames: { canvasId: string; frameId: string }[] }

export const EMPTY: SelectionState = { shares: [], last: null, popup: null, composed: null, told: [] }

type Result = { state: SelectionState; effects: SelectionEffect[] }

const refOf = (w: WholeFrame) => ({ canvasId: w.canvasId, frameId: w.frameId })

function wholeAnchor(w: WholeFrame): AnchorWire {
  return { source: w.file, frame: refOf(w), frames: [refOf(w)] }
}

const wholeLine = (w: WholeFrame): string => `${w.file} · "${w.title}"`

/** What each share stands for: a whole frame subsumes anything picked inside it. */
function member(share: Share): { anchor: AnchorWire; lines: string[] } | null {
  if (share.whole) return { anchor: wholeAnchor(share.whole), lines: [wholeLine(share.whole)] }
  return share.anchor ? { anchor: share.anchor, lines: share.lines } : null
}

/** Several shares as one anchor. Whole frames alone read as they always have,
 *  `frames`; anything mixing documents is `parts`, one per document. */
export function compositeAnchor(shares: readonly Share[]): AnchorWire | null {
  const members = shares.flatMap((s) => {
    const m = member(s)
    return m ? [m] : []
  })
  if (!members.length) return null
  const wholes = shares.flatMap((s) => (s.whole ? [s.whole] : []))
  if (wholes.length === members.length) {
    const refs = wholes.map(refOf)
    return wholes.length === 1
      ? { source: wholes[0]!.file, frames: refs }
      : { contains: groupLines(wholes.map(wholeLine)), frames: refs }
  }
  if (members.length === 1) return members[0]!.anchor
  return { contains: groupLines(members.flatMap((m) => m.lines)), parts: members.map((m) => m.anchor) }
}

/** More than one document, or a whole frame: past what one overlay can say. */
function spansDocuments(state: SelectionState): boolean {
  const live = state.shares.filter((s) => member(s))
  return live.length > 1 || live.some((s) => s.whole)
}

/** A guest composes on its own only while nothing else is in the selection. */
function multiFlags(state: SelectionState): Result {
  const wanted = spansDocuments(state) ? state.shares.filter((s) => s.anchor).map((s) => s.source) : []
  const effects: SelectionEffect[] = [
    ...state.told.filter((s) => !wanted.includes(s)).map((source) => ({ do: 'multi' as const, source, on: false })),
    ...wanted.filter((s) => !state.told.includes(s)).map((source) => ({ do: 'multi' as const, source, on: true })),
  ]
  return { state: { ...state, told: wanted }, effects }
}

function outline(state: SelectionState): SelectionEffect {
  return { do: 'outline', frames: state.shares.flatMap((s) => (s.whole ? [refOf(s.whole)] : [])) }
}

/** Whether the open popup takes more members: it is about this selection. */
export function extendable(state: SelectionState): boolean {
  return state.popup !== null && (state.composed === state.popup || state.shares.some((s) => s.source === state.popup && s.anchor))
}

function withShare(shares: Share[], source: string, change: (prev: Share | undefined) => Share | null): Share[] {
  const at = shares.findIndex((s) => s.source === source)
  const next = change(at >= 0 ? shares[at] : undefined)
  if (at < 0) return next ? [...shares, next] : shares
  return next ? shares.map((s, i) => (i === at ? next : s)) : shares.filter((_, i) => i !== at)
}

/** After the members changed: tell the guests, and point an open composer at
 *  what the selection now is. */
function changed(purpose: Purpose, prev: SelectionState, next: SelectionState): Result {
  const flags = multiFlags(next)
  const state = flags.state
  const effects = [...flags.effects, outline(state)]
  if (purpose !== 'compose' || !state.popup || !extendable(prev)) return { state, effects }
  if (spansDocuments(state)) {
    const anchor = compositeAnchor(state.shares)
    if (anchor) effects.push({ do: 'compose', host: state.popup, anchor, at: null })
    return { state: { ...state, composed: state.popup }, effects }
  }
  // Back to the popup's own document alone: its overlay composes it again, which
  // the `multi` off it was just sent says.
  return { state: { ...state, composed: null }, effects }
}

function ended(state: SelectionState): Result {
  const sources = [...new Set([...state.shares.map((s) => s.source), ...state.told])]
  const effects: SelectionEffect[] = state.told.map((source) => ({ do: 'multi' as const, source, on: false }))
  if (sources.length) effects.push({ do: 'end', sources })
  if (state.shares.some((s) => s.whole)) effects.push({ do: 'outline', frames: [] })
  return { state: { ...EMPTY, popup: state.popup }, effects }
}

export function reduceSelection(purpose: Purpose, state: SelectionState, e: SelectionEvent): Result {
  switch (e.t) {
    case 'share': {
      // A popup that is not about a Shift selection - a text run, a rebuilt
      // draft - takes nothing more: the share is handed straight back.
      if (purpose === 'compose' && e.anchor && state.popup && state.popup !== e.source && !extendable(state)) {
        return { state, effects: [{ do: 'end', sources: [e.source] }] }
      }
      const shares = withShare(state.shares, e.source, (prev) => {
        if (!e.anchor) return prev?.whole ? { ...prev, anchor: null, lines: [] } : null
        return { source: e.source, anchor: e.anchor, lines: e.lines, whole: prev?.whole ?? null }
      })
      // An empty share from a document that had none: an echo, nothing changed.
      if (shares === state.shares) return { state, effects: [] }
      const last = e.anchor ? { source: e.source, at: null } : state.last
      return changed(purpose, state, { ...state, shares, last })
    }

    case 'frames': {
      if (!e.frames.length) return { state, effects: [] }
      if (purpose === 'compose' && state.popup && (!e.add || !extendable(state))) return { state, effects: [] }
      const add = (shares: Share[]) =>
        e.frames.reduce(
          (acc, f) => withShare(acc, f.source, (prev) => ({ source: f.source, anchor: prev?.anchor ?? null, lines: prev?.lines ?? [], whole: f.whole })),
          shares,
        )
      const last = { source: e.host, at: e.at }
      if (e.add) return changed(purpose, state, { ...state, shares: add(state.shares), last })
      // A plain click or sweep is a selection of its own, settled at once: what
      // Shift had gathered elsewhere is dropped, not folded in.
      const cleared = ended(state)
      const fresh = { ...cleared.state, shares: add([]), last }
      const settled = reduceSelection(purpose, fresh, { t: 'settle' })
      return { state: settled.state, effects: [...cleared.effects, ...settled.effects] }
    }

    case 'settle': {
      if (!spansDocuments(state) || !state.last) return { state, effects: [] }
      const anchor = compositeAnchor(state.shares)
      if (!anchor) return { state, effects: [] }
      if (purpose === 'pick') {
        const done = ended(state)
        return { state: done.state, effects: [{ do: 'choose', ref: { anchor, label: shortAnchor(anchor) } }, ...done.effects] }
      }
      // Already open: Shift coming up changes nothing about what it is about.
      if (state.popup) return { state, effects: [] }
      return {
        state: { ...state, composed: state.last.source },
        effects: [{ do: 'compose', host: state.last.source, anchor, at: state.last.at }, outline(state)],
      }
    }

    case 'popup': {
      if (e.open) return { state: { ...state, popup: e.source }, effects: [] }
      if (state.popup !== e.source) return { state, effects: [] }
      return { ...ended(state), state: { ...EMPTY } }
    }

    case 'reset':
      return ended(state)
  }
}
