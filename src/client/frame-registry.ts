/** Every iframe the shell has an overlay in - the App's device previews and
 *  every mounted canvas frame - and the one place that talks to them. Nothing
 *  outside this module calls `contentWindow.postMessage`.
 *
 *  Identity is window *and* origin. A message is a guest's only if it came from
 *  that guest's window and that guest's origin - the shell's own for an App
 *  guest, the frame host's for a canvas guest - which is also what drops
 *  messages from the app's own nested iframes and from a canvas frame that
 *  navigated itself elsewhere. A message to a guest is addressed to its origin,
 *  and dropped when its kind does not receive that type (`receives`, from the
 *  one protocol table in `guest-messages.ts`).
 *
 *  Ids. App guests keep `'single'` and device ids. A canvas guest's id is
 *  `canvas:<canvasId>/<frameId>`, which is what `PickEffect.frame` and
 *  `PickState.frame` carry, so `reducePick` attributes a pick on either tab
 *  with no change to its own logic. */

import { type GuestKind, type Sender, type ShellMessage, receives } from './guest-messages.js'

/** An App preview: the device stage's own frame record `S`, tagged. */
export type AppGuest<S> = S & {
  kind: 'app'
  id: string
  iframe: HTMLIFrameElement
  /** `location.origin`: the proxied app is on the shell's origin. */
  origin: string
}

export interface CanvasGuest {
  kind: 'canvas'
  id: string
  iframe: HTMLIFrameElement
  /** The frame host's origin, from the url the daemon built. */
  origin: string
  place: { canvasId: string; frameId: string }
}

export type Guest<S> = AppGuest<S> | CanvasGuest

/** What the canvas UI may do with the registry: its own guests and posts. */
export interface CanvasGuestPort {
  add(guest: CanvasGuest): void
  remove(id: string): void
  post(id: string, message: ShellMessage): void
}

export function canvasGuestId(place: { canvasId: string; frameId: string }): string {
  return `canvas:${place.canvasId}/${place.frameId}`
}

export function senderOf(guest: Guest<unknown>): Sender {
  return guest.kind === 'canvas' ? { kind: 'canvas', place: guest.place } : { kind: 'app' }
}

export class FrameRegistry<S> implements CanvasGuestPort {
  private readonly guests = new Map<string, Guest<S>>()

  add(guest: Guest<S>): void {
    this.guests.set(guest.id, guest)
  }

  remove(id: string): void {
    this.guests.delete(id)
  }

  has(id: string): boolean {
    return this.guests.has(id)
  }

  get(id: string): Guest<S> | undefined {
    return this.guests.get(id)
  }

  /** The App preview with this id, for what only the device stage does. */
  app(id: string): AppGuest<S> | undefined {
    const guest = this.guests.get(id)
    return guest?.kind === 'app' ? guest : undefined
  }

  /** In registration order: the device stage registers in device order. */
  apps(): AppGuest<S>[] {
    return [...this.guests.values()].filter((g): g is AppGuest<S> => g.kind === 'app')
  }

  all(kind?: GuestKind): Guest<S>[] {
    const every = [...this.guests.values()]
    return kind ? every.filter((g) => g.kind === kind) : every
  }

  /** `rebuildStage` replaces the App previews; canvas guests stay mounted. */
  clearApps(): void {
    for (const guest of this.apps()) this.guests.delete(guest.id)
  }

  /** The guest a message came from, or null for anything else that posted. */
  from(source: MessageEventSource | null, origin: string): Guest<S> | null {
    if (!source) return null
    for (const guest of this.guests.values()) {
      if (guest.iframe.contentWindow === source && guest.origin === origin) return guest
    }
    return null
  }

  post(id: string, message: ShellMessage): void {
    const guest = this.guests.get(id)
    if (guest && receives(guest.kind, message.type)) {
      guest.iframe.contentWindow?.postMessage(message, guest.origin)
    }
  }

  /** To every guest whose kind receives `message.type`, but `except`. */
  postAll(message: ShellMessage, except?: string): void {
    for (const guest of this.guests.values()) {
      if (guest.id !== except) this.post(guest.id, message)
    }
  }

  /** The window `collectPageStorage` reads: the first App preview's - never
   *  "the first frame", which may be a canvas frame. */
  firstAppWindow(): Window | null {
    return this.apps()[0]?.iframe.contentWindow ?? null
  }
}
