/** What every turn tells the agent about tabs and canvases. Per turn, not once
 *  per chat like the history brief, because tabs open and close between turns.
 *
 *  The view is the one `/send` sealed onto the batch (`FeedbackBatch.view`),
 *  not the tab showing when the batch is delivered: a batch queued behind a
 *  working turn is about what the user was looking at when they sent it. */

import type { BatchView } from '../protocol.js'
import { CANVAS_SERVER_NAME, CANVAS_TOOL_NAMES } from './mcp.js'
import { CANVASES_DIR, type CanvasInventory } from './types.js'

/** At most this many canvases are listed, open first, then archived by
 *  recency; the rest are counted, and `list_canvases` has them all. */
export const BRIEF_MAX_CANVASES = 12

export interface CanvasBriefInput {
  inventory: CanvasInventory
  view: BatchView | undefined
  /** The attached dev server, when there is an App tab. */
  app: string | null
  /** Whether this agent has the canvas tools. Without them nothing about
   *  canvases is said: describing tools it cannot call invites it to write
   *  `canvas.json` by hand. */
  tools: boolean
}

/** Lines for `acpPrompt`; empty without tools, so the prompt is unchanged. */
export function canvasBrief(input: CanvasBriefInput): string[] {
  if (!input.tools) return []
  const all = input.inventory.canvases
  const open = all.filter((c) => !c.archived).sort((a, b) => a.createdAt - b.createdAt)
  const archived = all.filter((c) => c.archived).sort((a, b) => b.createdAt - a.createdAt)
  const shownOpen = open.slice(0, BRIEF_MAX_CANVASES)
  const shownArchived = archived.slice(0, Math.max(0, BRIEF_MAX_CANVASES - shownOpen.length))
  const more = all.length - shownOpen.length - shownArchived.length
  const plural = (n: number) => `${n} frame${n === 1 ? '' : 's'}`
  const tabs = [
    ...(input.app ? [`App (${input.app})`] : []),
    ...shownOpen.map((c) => `canvas "${c.name}" (${c.id}, ${plural(c.frames)})`),
  ]
  const where = (() => {
    const view = input.view
    if (!view) return null
    if (view.tab === 'app') return `The user was on the App tab at ${view.page} when they sent this.`
    const canvas = all.find((c) => c.id === view.canvasId)
    return canvas
      ? `The user was on canvas "${canvas.name}" (${canvas.id}) when they sent this.`
      : `The user was on a canvas that has since been deleted (${view.canvasId}) when they sent this.`
  })()
  const view = input.view
  const target = (view?.tab === 'canvas' ? open.find((c) => c.id === view.canvasId) : undefined) ?? open.at(-1)
  return [
    '',
    `The review shell has these tabs: ${tabs.join(', ') || 'none'}.` +
      (shownArchived.length ? ` Archived: ${shownArchived.map((c) => `"${c.name}" (${c.id})`).join(', ')}.` : '') +
      (more > 0 ? ` ${more} more: call list_canvases.` : ''),
    ...(where ? [where] : []),
    `Items with anchor.frame were made inside a canvas frame; anchor.source is then a line of that frame's file under ${CANVASES_DIR}/.`,
    "A frame's HTML is yours: change it with update_frame or by editing that file. Its position is the user's and its width is fixed; when the content needs a different height, pass height to update_frame rather than adding the frame again. Never edit canvas.json or layout.json.",
    `To show the user designs, mockups or alternatives side by side, put each one in a frame on a canvas. Canvas tools (${CANVAS_SERVER_NAME}): ${CANVAS_TOOL_NAMES.join(', ')}.`,
    target
      ? `Add new frames to canvas "${target.name}" (${target.id}). Call create_canvas only when the user asks for a new canvas or this one is full.`
      : 'No canvas is open: create one with create_canvas for new frames.',
    '',
  ]
}
