/** How the overlay reaches the review: the only things it ever needed the
 *  shell's origin for, behind one interface.
 *
 *  - `direct`: an App preview, or an unframed page. Same origin as the api: it
 *    posts to `location.origin` and calls the api. A preview gets snapshots from
 *    the shell; only an unframed page listens to an `EventSource` of its own.
 *  - `relay`: a canvas frame on the frame host. It has no api it may call
 *    (`refuseCrossSite`) and no reason to hold forty event streams: every call
 *    goes to the shell by `postMessage`, addressed to the shell's origin, and
 *    the shell pushes the frame its own annotations.
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
    /** Its number in the whole queue, on a relayed subset. */
    n?: number
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
  const shellOrigin = script.dataset.ezShell
  return shellOrigin ? relayLink({ shellOrigin }) : inertLink()
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
      if (window.parent === window) {
        const events = new EventSource(`${api}/events`)
        events.onmessage = (e) => onSnapshot(JSON.parse(e.data) as OverlaySnapshot)
        return
      }
      window.addEventListener('message', (e: MessageEvent) => {
        const data = e.data as { type?: string; snapshot?: OverlaySnapshot }
        if (e.source === window.parent && e.origin === location.origin && data?.type === 'ez:snapshot' && data.snapshot) {
          onSnapshot(data.snapshot)
        }
      })
    },
    fromShell: (e) => e.origin === location.origin,
  }
}

/** A request the shell never answers - it reloaded - fails after this, which a
 *  composer shows as a failed save, the same as a network error. */
const RELAY_TIMEOUT_MS = 10_000

/** Requests carry a `reqId`; `ez:relay-done {reqId, ok, body}` settles them.
 *  Snapshots arrive as `ez:snapshot`, holding only this frame's annotations. */
export function relayLink(config: { shellOrigin: string }): OverlayLink {
  const { shellOrigin } = config
  const pending = new Map<string, { resolve: (body: unknown) => void; reject: (err: Error) => void }>()
  const listeners: ((snapshot: OverlaySnapshot) => void)[] = []
  let last: OverlaySnapshot | null = null
  let seq = 0
  const fromShell = (e: MessageEvent) => e.source === window.parent && e.origin === shellOrigin
  const post = (message: Record<string, unknown>) => window.parent?.postMessage(message, shellOrigin)

  window.addEventListener('message', (e: MessageEvent) => {
    if (!fromShell(e)) return
    const data = e.data as { type?: string; reqId?: string; ok?: boolean; body?: unknown; snapshot?: OverlaySnapshot }
    if (data?.type === 'ez:relay-done' && typeof data.reqId === 'string') {
      const waiting = pending.get(data.reqId)
      pending.delete(data.reqId)
      if (!waiting) return
      if (data.ok) waiting.resolve(data.body)
      else waiting.reject(new Error((data.body as { error?: string } | null)?.error ?? 'refused'))
    }
    if (data?.type === 'ez:snapshot' && data.snapshot) {
      last = data.snapshot
      for (const listener of listeners) listener(data.snapshot)
    }
  })

  const request = (op: Record<string, unknown>, transfer?: Transferable[]) =>
    new Promise<unknown>((resolve, reject) => {
      const reqId = `r${++seq}-${Date.now().toString(36)}`
      pending.set(reqId, { resolve, reject })
      window.setTimeout(() => {
        if (pending.delete(reqId)) reject(new Error('the review did not answer'))
      }, RELAY_TIMEOUT_MS)
      window.parent?.postMessage({ type: 'ez:relay', reqId, op }, shellOrigin, transfer)
    })

  return {
    kind: 'relay',
    post,
    annotate: async (body) => {
      await request({ op: 'annotate', body })
    },
    attachments: {
      upload: async (file) => {
        const bytes = await file.arrayBuffer()
        const name = file.name || 'image.png'
        return (await request(
          { op: 'upload', name, mime: file.type || 'application/octet-stream', bytes },
          [bytes],
        )) as { id: string; name: string }
      },
      discard: (id) => {
        request({ op: 'discard-upload', id }).catch(() => {})
      },
    },
    subscribe: (onSnapshot) => {
      listeners.push(onSnapshot)
      if (last) onSnapshot(last)
    },
    fromShell,
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
