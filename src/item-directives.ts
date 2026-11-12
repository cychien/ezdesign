/** Folding what each queued comment's own box named - its `$` skills and its
 *  `#` place - into the batch they are sent in. Pure, so the renumbering can be
 *  tested without a store.
 *
 *  A skill and a place are about the turn, not about one element, so the agent
 *  reads them off the batch: `skills` is the batch's list, and `[skill n]` in any
 *  comment is `skills[n-1]`. Each comment counted its own from 1, so its markers
 *  are renumbered into the batch's list here, once. */

import type { Annotation, BatchTarget } from './protocol.js'

const SKILL_MARKER = /\[skill (\d+)\]/g
const TARGET_MARKER = '[target 1]'

const samePlace = (a: BatchTarget, b: BatchTarget): boolean =>
  a.kind === b.kind && (a.kind !== 'canvas' || (b.kind === 'canvas' && a.canvasId === b.canvasId))

export interface FoldedBatch {
  skills: string[]
  target: BatchTarget | undefined
  items: Annotation[]
}

/** The note's skills come first, then each comment's in queue order, each name
 *  once. The note's place wins; without one, the first comment that named a
 *  place sets it. A comment whose place is not the batch's keeps it as words,
 *  `#label`, rather than a marker that would read as the batch's place. */
export function foldItemDirectives(
  skills: readonly string[],
  target: BatchTarget | undefined,
  items: readonly Annotation[],
): FoldedBatch {
  const merged = [...skills]
  const batchTarget = target ?? items.find((item) => item.target)?.target
  const folded = items.map((item) => {
    const { skills: own, target: place, ...rest } = item
    if (!own?.length && !place) return rest
    let comment = rest.comment.replace(SKILL_MARKER, (whole, n: string) => {
      const name = own?.[Number(n) - 1]
      if (name === undefined) return whole
      if (!merged.includes(name)) merged.push(name)
      return `[skill ${merged.indexOf(name) + 1}]`
    })
    if (place && batchTarget && !samePlace(place, batchTarget)) {
      comment = comment.replaceAll(TARGET_MARKER, `#${place.label}`)
    }
    return { ...rest, comment }
  })
  return { skills: merged, target: batchTarget, items: folded }
}
