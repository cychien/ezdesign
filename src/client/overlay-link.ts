/** How the overlay reaches the review: the only things it ever needed the
 *  shell's origin for, behind one interface.
 *
 *  - `direct`: an App preview, or an unframed page. Same origin as the api: it
 *    posts to `location.origin`, calls the api, and listens to its own
 *    `EventSource`.
 *  - `relay`: a canvas frame on the frame host. It has no api it may call
 *    (`refuseCrossSite`); every call goes to the shell by `postMessage`.
 *
 *  Chosen once at boot from the overlay's own script tag, which the daemon
 *  wrote, so a page cannot switch an App overlay into relay. */

import { type AttachmentTransport, directAttachments } from './attach.js'
import type { AnchorWire } from './draft.js'

/** The part of the snapshot an overlay draws from. */
export interface OverlaySnapshot {
  state: 'active' | 'ended'
  annotations: {
    id: string
    kind: 'element' | 'point' | 'text' | 'page'
    comment: string
    anchor: AnchorWire
  }[]
}

export interface OverlayLink {
  readonly kind: 'direct' | 'relay'
  /** To the shell. A no-op unframed. */
  post(message: Record<string, unknown>): void
  /** `POST /annotations`, or its relay. Rejects on refusal. */
  annotate(body: Record<string, unknown> & { anchor: AnchorWire }): Promise<void>
  readonly attachments: AttachmentTransport
  /** Called with every snapshot, the first as soon as one is known. */
  subscribe(onSnapshot: (snapshot: OverlaySnapshot) => void): void
  /** Whether a message event is from the shell this overlay answers to. */
  fromShell(e: MessageEvent): boolean
}

/** Read the overlay's own `<script>` and build the link it was configured for.
 *  A relay overlay with no shell to relay through annotates nothing - never a
 *  fallback to `direct`. */
export function linkFromScript(script: HTMLScriptElement | null, api: string): OverlayLink {
  if (script?.dataset.ezLink !== 'relay') return directLink(api)
  return inertLink()
}

export function directLink(api: string): OverlayLink {
  return {
    kind: 'direct',
    post: (message) => window.parent?.postMessage(message, location.origin),
    annotate: async (body) => {
      const res = await fetch(`${api}/annotations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`annotation rejected (${res.status})`)
    },
    attachments: directAttachments(api),
    subscribe: (onSnapshot) => {
      const events = new EventSource(`${api}/events`)
      events.onmessage = (e) => onSnapshot(JSON.parse(e.data) as OverlaySnapshot)
    },
    fromShell: (e) => e.origin === location.origin,
  }
}

function inertLink(): OverlayLink {
  const refused = () => Promise.reject(new Error('this frame has no review to report to'))
  return {
    kind: 'relay',
    post: () => {},
    annotate: refused,
    attachments: { upload: refused, discard: () => {} },
    subscribe: () => {},
    fromShell: () => false,
  }
}
