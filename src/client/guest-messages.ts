/** The shell <-> overlay message protocol, in one table, both directions, with
 *  who may send or receive each message.
 *
 *  A guest is an iframe the shell has an overlay in: an `app` guest is the
 *  user's own app on the shell's origin; a `canvas` guest is an agent-written
 *  page on the frame host, whose scripts can impersonate the overlay in it. So
 *  the table is also the trust boundary:
 *
 *  - up (guest -> shell): `parseGuestMessage` is the only reader of a guest's
 *    `postMessage` data. It refuses a type the guest's kind may not send, checks
 *    every field, and stamps where the guest is onto every anchor it carries
 *    (`Anchor.frame` from the registered guest, never from the message), so a
 *    frame cannot speak for another frame. A canvas guest may not navigate,
 *    explore, or fire the send and cancel shortcuts (`ez:key` carries the
 *    sender's kind; `runShortcut` honours it).
 *  - down (shell -> guest): `FrameRegistry.post`/`postAll` drop a message the
 *    recipient's kind does not receive, so no call site decides fan-out.
 *
 *  Adding a message is one entry here; the union types, the parser and the
 *  fan-out all derive from it. */

import type { AnchorWire, DraftWire, RefWire } from './draft.js'

export type GuestKind = 'app' | 'canvas'

/** What the parser needs to know about the sender. */
export interface Sender {
  kind: GuestKind
  /** Canvas guests only: the frame the shell mounted this window for. */
  place?: { canvasId: string; frameId: string }
}

export type Mode = 'off' | 'element' | 'region'

export interface KeyChordWire {
  key: string
  metaKey: boolean
  ctrlKey: boolean
}

/** What a relay overlay asks the shell to do for it: exactly the api calls an
 *  overlay makes, and no others. Answered with `ez:relay-done`. */
export type RelayOp =
  | { op: 'annotate'; body: Record<string, unknown> & { anchor: AnchorWire } }
  | { op: 'upload'; name: string; mime: string; file: Blob }
  | { op: 'discard-upload'; id: string }

type Raw = Record<string, unknown>

interface Down {
  readonly dir: 'down'
  readonly to: readonly GuestKind[]
}

interface Up<M> {
  readonly dir: 'up'
  readonly from: readonly GuestKind[]
  /** Null for a malformed message. Runs only for a kind in `from`. */
  readonly parse: (raw: Raw, sender: Sender) => M | null
}

const BOTH = ['app', 'canvas'] as const
const APP = ['app'] as const
const CANVAS = ['canvas'] as const

const down = (to: readonly GuestKind[]): Down => ({ dir: 'down', to })
const up = <M>(from: readonly GuestKind[], parse: (raw: Raw, sender: Sender) => M | null): Up<M> => ({
  dir: 'up',
  from,
  parse,
})

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Raw | null => (typeof v === 'object' && v !== null ? (v as Raw) : null)
const mode = (v: unknown): Mode | null =>
  v === 'off' || v === 'element' || v === 'region' ? v : null
const pickId = (raw: Raw) => str(raw.pickId)

/** The sender's place, written over whatever the anchor claimed: an app guest's
 *  anchors carry no `frame`, a canvas guest's carry exactly its own. */
export function attributeAnchor(anchor: AnchorWire, sender: Sender): AnchorWire {
  const { frame: _claimed, ...rest } = anchor
  return sender.place ? { ...rest, frame: sender.place } : rest
}

export const GUEST_PROTOCOL = {
  // ------------------------------------------------------------ shell -> guest
  'ez:set-mode': down(BOTH),
  'ez:escape': down(BOTH),
  /** `{preset, zoom, scoped}`; for a canvas frame `zoom` is the board's. */
  'ez:viewport': down(BOTH),
  'ez:pick': down(BOTH),
  'ez:pick-abort': down(BOTH),
  /** `{pickId, ref, draft}`: another frame answered this frame's popup pick. */
  'ez:pick-resolve': down(BOTH),
  'ez:restore': down(BOTH),
  'ez:hold': down(BOTH),
  'ez:can-explore': down(APP),
  'ez:in-explore': down(APP),
  'ez:variant': down(APP),
  'ez:variants-clear': down(APP),
  'ez:scroll-to': down(APP),
  /** The session state and annotations: a canvas guest gets its own subset,
   *  an App preview all of them. Neither holds an event stream of its own. */
  'ez:snapshot': down(BOTH),
  /** Relay: `{reqId, ok, body}` settling an `ez:relay`. */
  'ez:relay-done': down(CANVAS),
  /** `{reqId, files}` or `{reqId, error}` settling an `ez:library-pick`;
   *  `files` is empty when the user called it off. */
  'ez:library-picked': down(BOTH),

  // ------------------------------------------------------------ guest -> shell
  'ez:ready': up(BOTH, (r) => {
    const page = str(r.page) ?? '/'
    return { page, url: str(r.url) ?? page }
  }),
  /** An SPA route change. A canvas frame is one document with no page to move. */
  'ez:page': up(APP, (r) => {
    const url = str(r.url)
    return url === null ? null : { url }
  }),
  'ez:navigate': up(APP, (r) => {
    const url = str(r.url)
    return url === null ? null : { url }
  }),
  'ez:mode': up(BOTH, (r) => {
    const m = mode(r.mode)
    return m === null ? null : { mode: m }
  }),
  'ez:popup': up(BOTH, (r) => ({ open: r.open === true })),
  'ez:pick-armed': up(BOTH, (r) => {
    const id = pickId(r)
    return id === null ? null : { pickId: id, host: r.host === 'note' ? ('note' as const) : ('popup' as const) }
  }),
  'ez:draft': up(BOTH, (r) => {
    const id = pickId(r)
    const draft = obj(r.draft)
    return id === null || !draft ? null : { pickId: id, draft: draft as unknown as DraftWire }
  }),
  'ez:picked': up(BOTH, (r, sender) => {
    const id = pickId(r)
    const ref = obj(r.ref) as unknown as RefWire | null
    if (id === null || !ref || !obj(ref.anchor)) return null
    return {
      pickId: id,
      ref: { ...ref, anchor: attributeAnchor(ref.anchor, sender) },
      page: str(r.page) ?? '/',
    }
  }),
  'ez:draft-done': up(BOTH, (r) => {
    const id = pickId(r)
    return id === null ? null : { pickId: id }
  }),
  'ez:draft-expired': up(BOTH, (r) => {
    const id = pickId(r)
    return id === null ? null : { pickId: id }
  }),
  'ez:pick-cancelled': up(BOTH, (r) => {
    const id = pickId(r)
    return id === null ? null : { pickId: id, resumed: r.resumed === true }
  }),
  /** Variants on canvas frames are backlog. */
  'ez:explore': up(APP, (r) => {
    if (!r.anchor || !r.capture) return null
    return {
      anchor: r.anchor,
      capture: r.capture,
      direction: str(r.direction) ?? '',
      attachments: Array.isArray(r.attachments) ? r.attachments.filter((a) => typeof a === 'string') : [],
      references: Array.isArray(r.references) ? (r.references as RefWire[]) : [],
    }
  }),
  'ez:explore-held': up(APP, (r) => {
    const draft = obj(r.draft)
    return draft ? { draft: draft as unknown as DraftWire } : null
  }),
  /** `guest` is who pressed it: a canvas guest runs only the shortcuts marked
   *  `fromCanvas` - never send, cancel or a new chat. */
  'ez:key': up(BOTH, (r, sender) => {
    const chord = obj(r.chord)
    if (!chord || typeof chord.key !== 'string') return null
    return {
      chord: { key: chord.key, metaKey: chord.metaKey === true, ctrlKey: chord.ctrlKey === true },
      guest: sender.kind,
    }
  }),
  /** Mod+wheel, and from a canvas guest any wheel while annotating or picking:
   *  pan or zoom the stage or the board. `at` is in the guest's viewport. */
  'ez:wheel': up(BOTH, (r) => {
    const at = obj(r.at)
    const x = at ? num(at.x) : null
    const y = at ? num(at.y) : null
    return {
      dx: num(r.dx) ?? 0,
      dy: num(r.dy) ?? 0,
      zoom: r.zoom === true,
      ...(x !== null && y !== null ? { at: { x, y } } : {}),
    }
  }),
  /** Device-grid scroll sync. */
  'ez:scroll': up(APP, (r) => {
    const ratio = num(r.ratio)
    return ratio === null ? null : { ratio }
  }),
  /** A composer's `/library`: the library opens in the shell, over every frame,
   *  and the shell copies what was chosen into the session's attachments. */
  'ez:library-pick': up(BOTH, (r) => {
    const reqId = str(r.reqId)
    return reqId === null ? null : { reqId }
  }),
  /** Relay: a canvas guest has no api of its own (`refuseCrossSite`). */
  'ez:relay': up(CANVAS, (r, sender) => {
    const reqId = str(r.reqId)
    const op = obj(r.op)
    const parsed = op ? parseRelayOp(op, sender) : null
    return reqId === null || parsed === null ? null : { reqId, op: parsed }
  }),
} as const

/** annotate: a body object with an anchor object, `body.anchor` replaced by
 *  `attributeAnchor(anchor, sender)`; upload: `name` and `mime` strings and a
 *  `Blob`; discard-upload: an `id` string. Anything else is null. */
function parseRelayOp(op: Raw, sender: Sender): RelayOp | null {
  switch (op.op) {
    case 'annotate': {
      const body = obj(op.body)
      const anchor = body ? obj(body.anchor) : null
      if (!body || !anchor) return null
      return {
        op: 'annotate',
        body: { ...body, anchor: attributeAnchor(anchor as AnchorWire, sender) },
      }
    }
    case 'upload': {
      const name = str(op.name)
      const mime = str(op.mime)
      if (name === null || mime === null || !(op.file instanceof Blob)) return null
      return { op: 'upload', name, mime, file: op.file }
    }
    case 'discard-upload': {
      const id = str(op.id)
      return id === null ? null : { op: 'discard-upload', id }
    }
    default:
      return null
  }
}

type Protocol = typeof GUEST_PROTOCOL

export type ShellToGuestType = {
  [K in keyof Protocol]: Protocol[K] extends Down ? K : never
}[keyof Protocol]

export type GuestToShellType = {
  [K in keyof Protocol]: Protocol[K] extends Up<unknown> ? K : never
}[keyof Protocol]

/** Every message the shell may receive, as the parser produced it. */
export type GuestMessage = {
  [K in GuestToShellType]: { type: K } & (Protocol[K] extends Up<infer M> ? M : never)
}[GuestToShellType]

/** Every message the shell may send: the type is checked against the table;
 *  the fields are the overlay's to read. */
export type ShellMessage = { type: ShellToGuestType } & Record<string, unknown>

/** The one reader of a guest's message data. Null for anything malformed and
 *  for anything this sender's kind may not say. */
export function parseGuestMessage(data: unknown, sender: Sender): GuestMessage | null {
  const raw = obj(data)
  const type = raw ? str(raw.type) : null
  if (!raw || type === null || !Object.hasOwn(GUEST_PROTOCOL, type)) return null
  const entry = GUEST_PROTOCOL[type as keyof Protocol]
  if (entry.dir !== 'up' || !(entry.from as readonly GuestKind[]).includes(sender.kind)) return null
  const fields = (entry.parse as (raw: Raw, sender: Sender) => object | null)(raw, sender)
  return fields === null ? null : ({ type, ...fields } as GuestMessage)
}

/** Whether a guest of `kind` receives `type`. */
export function receives(kind: GuestKind, type: ShellToGuestType): boolean {
  return (GUEST_PROTOCOL[type].to as readonly GuestKind[]).includes(kind)
}
