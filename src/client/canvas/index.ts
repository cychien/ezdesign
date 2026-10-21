/** The canvas feature's one entry into the shell.
 *
 *  `shell.ts` stays the owner of the snapshot, the SSE connection, the
 *  composer, the pick transaction, the device stage and the one window
 *  `message` listener. This module owns the tab strip, the boards, the relay for
 *  canvas guests, and everything canvas-shaped, and reaches the shell only
 *  through `ShellPorts`. The shell calls back: `render` per snapshot, `onEvent`
 *  per named SSE event, `fromGuest` per parsed message from a canvas guest, and
 *  `onKeyDown` for keys its own table did not take.
 *
 *  Installed on the first snapshot or canvas event, whichever comes first. */

import type { BatchView, FrameRef } from '../../protocol.js'
import { type CanvasId, type TabId, asCanvasId } from '../../canvas/types.js'
import type {
  CanvasEventWire,
  CanvasSnapshotWire,
  CanvasWire,
  DuplicateWire,
  LayoutStepWire,
  OpId,
  ViewWire,
} from '../../canvas/wire.js'
import type { CanvasGuest, CanvasGuestPort } from '../frame-registry.js'
import type { GuestMessage, Mode, RelayOp } from '../guest-messages.js'
import type { OverlaySnapshot } from '../overlay-link.js'
import { BoardView } from './board-view.js'
import { LABELS } from './names.js'
import { TabStrip, tabsModel } from './tabs.js'

/** What the shell lends the feature. Narrow on purpose: the next contributor
 *  who needs more adds a port here rather than importing `shell.ts` state. */
export interface ShellPorts {
  guests: CanvasGuestPort
  /** Where the strip and the boards go. */
  stageWrap: HTMLElement
  /** The device stage: hidden while a canvas tab is active, never detached. */
  stage: HTMLElement
  /** `fetch` against `${API}${path}` with JSON headers, as `api()` in the shell. */
  api: (path: string, init?: RequestInit) => Promise<Response>
  /** A tab came on screen: the shell repaints what depends on which (the
   *  header's address, the size controls, and the stage, which measures 0 wide
   *  while hidden). */
  onTabShown: (tab: TabId | null) => void
  /** Escape, or a click on the empty board: stand down any pick or popup. */
  escape: () => void
  /** The shell's confirm card, for a permanent delete. */
  confirm: (offer: { title: string; body: string; go: string }) => Promise<boolean>
  /** Say something went wrong, where the user is looking. */
  notice: (text: string) => void
  annotateMode: () => Mode
}

/** The snapshot fields this module reads. */
export interface CanvasShellSnapshot {
  app?: string
  canvas?: CanvasSnapshotWire
  state: OverlaySnapshot['state']
  /** Forwarded to each canvas guest as they are, filtered by `anchor.frame`. */
  annotations: readonly { anchor: { frame?: FrameRef } }[]
}

export interface CanvasUi {
  /** Per snapshot: repaint the strip, follow the daemon's active tab, dispose
   *  boards of canvases now gone or closed, and push each canvas guest its own
   *  annotations - only when that subset changed. */
  render(snapshot: CanvasShellSnapshot): void
  onEvent(event: CanvasEventWire): void
  /** What only a canvas guest says, or what it says differently. True when
   *  handled; anything else goes through the shell's shared handling. */
  fromGuest(guest: CanvasGuest, message: GuestMessage): boolean
  /** Board keys while a board is active and focus is not in a field. */
  onKeyDown(e: KeyboardEvent): boolean
  onKeyUp(e: KeyboardEvent): void
  setAnnotating(mode: Mode): void
  /** An `/element` pick is out: frames take the pointer so it can be answered
   *  on any canvas, as the App's previews always can. */
  setPicking(on: boolean): void
  readonly activeTab: TabId | null
  /** The name of the canvas on screen, null on the App tab. */
  readonly activeName: string | null
  /** What `/send` stamps on the batch: the turn names the view the user sent
   *  from, not the one showing when it is delivered. */
  batchView(appPage: string): BatchView
  /** A frame's title, for the queue's labels. */
  frameTitle(ref: FrameRef): string | undefined
  /** Show the tab a guest lives on: the App for an App preview, its canvas for
   *  a canvas frame. How `/element` brings the user back to the composer. */
  focusGuest(guestId: string): void
}

/** Everything the client asks the canvas routes for, as data. */
export type CanvasRequest =
  | { do: 'create' }
  | { do: 'get'; canvasId: CanvasId }
  | { do: 'rename'; canvasId: CanvasId; name: string }
  | { do: 'archive'; canvasId: CanvasId }
  | { do: 'reopen'; canvasId: CanvasId }
  | { do: 'delete'; canvasId: CanvasId }
  | { do: 'ops'; canvasId: CanvasId; step: LayoutStepWire }
  | { do: 'duplicate'; canvasId: CanvasId; input: DuplicateWire }
  | { do: 'view'; view: ViewWire }

/** The one place the canvas urls are spelled on the client. Resolves with the
 *  answer's body, or rejects with the daemon's own words. */
export async function canvasRequest(api: ShellPorts['api'], request: CanvasRequest): Promise<unknown> {
  const [method, path, body]: [string, string, unknown?] = (() => {
    switch (request.do) {
      case 'create':
        return ['POST', '/canvases', {}]
      case 'get':
        return ['GET', `/canvases/${request.canvasId}`]
      case 'rename':
        return ['PATCH', `/canvases/${request.canvasId}`, { name: request.name }]
      case 'archive':
        return ['POST', `/canvases/${request.canvasId}/archive`, {}]
      case 'reopen':
        return ['POST', `/canvases/${request.canvasId}/reopen`, {}]
      case 'delete':
        return ['DELETE', `/canvases/${request.canvasId}`]
      case 'ops':
        return ['POST', `/canvases/${request.canvasId}/ops`, request.step]
      case 'duplicate':
        return ['POST', `/canvases/${request.canvasId}/frames`, request.input]
      case 'view':
        return ['PUT', '/view', request.view]
    }
  })()
  const res = await api(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const answer = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(answer?.error ?? `HTTP ${res.status}`)
  return answer
}

/** An `ez:relay` op as the api call the guest's overlay could not make. The
 *  anchor of an annotation already carries the guest's `frame`, stamped by the
 *  parser from the window it came from. */
async function relayCall(api: ShellPorts['api'], op: RelayOp): Promise<Response> {
  switch (op.op) {
    case 'annotate':
      return api('/annotations', { method: 'POST', body: JSON.stringify(op.body) })
    case 'upload':
      return api('/attachments', {
        method: 'POST',
        headers: { 'content-type': op.mime, 'x-ez-name': encodeURIComponent(op.name) },
        body: op.bytes,
      })
    case 'discard-upload':
      return api(`/attachments/${encodeURIComponent(op.id)}`, { method: 'DELETE' })
  }
}

/** One per request: the daemon remembers recent ones, so a replay is a no-op. */
const newOpId = (): OpId =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('') as OpId

export function installCanvas(ports: ShellPorts): CanvasUi {
  const boards = new Map<CanvasId, BoardView>()
  /** Canvases as last pushed, so a tab mounts with no fetch. */
  const docs = new Map<CanvasId, CanvasWire>()
  /** What each canvas guest was last pushed, by signature. */
  const pushed = new Map<string, string>()
  let shown: TabId | null = null
  let snapshot: CanvasShellSnapshot | null = null

  ports.stageWrap.classList.add('ez-tabbed')
  const strip = new TabStrip({
    select: (tab) => select(tab),
    close: (id) => void request({ do: 'archive', canvasId: id }),
    create: () => void request({ do: 'create' }),
    rename: (id, name) => void request({ do: 'rename', canvasId: id, name }),
    reopen: (id) => void request({ do: 'reopen', canvasId: id }),
    delete: async (id, name) => {
      const sure = await ports.confirm({
        title: LABELS.confirmTitle(name),
        body: LABELS.confirmBody,
        go: LABELS.confirmGo,
      })
      if (sure) await request({ do: 'delete', canvasId: id })
    },
  })
  ports.stageWrap.prepend(strip.el)

  async function request(r: CanvasRequest): Promise<unknown> {
    try {
      return await canvasRequest(ports.api, r)
    } catch (err) {
      ports.notice(`canvas：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  function board(id: CanvasId): BoardView | null {
    const existing = boards.get(id)
    if (existing) return existing
    const doc = docs.get(id)
    if (!doc) return null
    const made = new BoardView(doc, {
      guests: ports.guests,
      send: async (edit) =>
        (await request(
          edit.t === 'ops'
            ? { do: 'ops', canvasId: id, step: { opId: newOpId(), ops: edit.ops } }
            : { do: 'duplicate', canvasId: id, input: edit.input },
        )) as CanvasWire | null,
      saveCamera: (camera) => void request({ do: 'view', view: { camera: { canvasId: id, camera } } }),
      escape: ports.escape,
    })
    made.setAnnotating(ports.annotateMode())
    boards.set(id, made)
    ports.stageWrap.append(made.el)
    return made
  }

  /** Which tab is on screen. The device stage is hidden, never detached, while
   *  a canvas is showing, so its previews keep their state. */
  function show(tab: TabId | null): void {
    if (tab === shown) return
    const next = tab === null || tab === 'app' ? null : board(tab)
    if (tab !== null && tab !== 'app' && !next) {
      // Not pushed yet: fetch it once, then show it.
      void request({ do: 'get', canvasId: tab }).then((doc) => {
        if (!doc) return
        docs.set(tab, doc as CanvasWire)
        shown = null
        show(tab)
      })
      return
    }
    shown = tab
    for (const [id, b] of boards) if (id !== tab) b.hide()
    ports.stage.hidden = tab !== 'app'
    ports.onTabShown(tab)
    if (next) {
      next.show()
      next.el.focus({ preventScroll: true })
    }
  }

  /** Optimistic, then `PUT /view`, so every shell and the agent agree. A pick
   *  in flight stays armed across the switch. */
  function select(tab: TabId): void {
    show(tab)
    if (snapshot?.canvas) snapshot = { ...snapshot, canvas: { ...snapshot.canvas, activeTab: tab } }
    paintStrip()
    void request({ do: 'view', view: { activeTab: tab } })
  }

  function paintStrip(): void {
    if (!snapshot?.canvas) return
    strip.paint(tabsModel(snapshot.app, snapshot.canvas))
  }

  function activeBoard(): BoardView | null {
    return shown && shown !== 'app' ? (boards.get(shown) ?? null) : null
  }

  /** Each canvas guest is handed only its own frame's annotations. */
  function pushAnnotations(s: CanvasShellSnapshot): void {
    const byGuest = new Map<string, unknown[]>()
    s.annotations.forEach((a, i) => {
      const frame = a.anchor.frame
      if (!frame) return
      const id = `canvas:${frame.canvasId}/${frame.frameId}`
      byGuest.set(id, [...(byGuest.get(id) ?? []), { ...a, n: i + 1 }])
    })
    for (const b of boards.values()) {
      for (const guestId of b.guestIds()) {
        const subset = { state: s.state, annotations: byGuest.get(guestId) ?? [] }
        const signature = JSON.stringify(subset)
        if (pushed.get(guestId) === signature) continue
        pushed.set(guestId, signature)
        ports.guests.post(guestId, { type: 'ez:snapshot', snapshot: subset })
      }
    }
  }

  return {
    render(s) {
      snapshot = s
      if (!s.canvas) return
      const model = tabsModel(s.app, s.canvas)
      strip.paint(model)
      for (const [id, b] of boards) {
        const summary = s.canvas.canvases.find((c) => c.id === id)
        if (!summary || summary.archived) {
          b.dispose()
          boards.delete(id)
          for (const key of [...pushed.keys()]) if (key.startsWith(`canvas:${id}/`)) pushed.delete(key)
        }
      }
      show(model.active)
      pushAnnotations(s)
    },

    onEvent(event) {
      if (event.type === 'canvas') {
        docs.set(event.canvas.id, event.canvas)
        boards.get(event.canvas.id)?.apply(event.canvas)
      } else {
        docs.delete(event.canvasId)
        boards.get(event.canvasId)?.dispose()
        boards.delete(event.canvasId)
      }
      if (snapshot) pushAnnotations(snapshot)
    },

    fromGuest(guest, message) {
      const b = boards.get(guest.place.canvasId as CanvasId)
      const frame = b?.frameOf(guest.id)
      switch (message.type) {
        case 'ez:wheel':
          if (b && frame) b.onGuestWheel(frame, message)
          return true
        case 'ez:relay':
          void relayCall(ports.api, message.op).then(
            async (res) => {
              const body = await res.json().catch(() => null)
              ports.guests.post(guest.id, { type: 'ez:relay-done', reqId: message.reqId, ok: res.ok, body })
            },
            () => ports.guests.post(guest.id, { type: 'ez:relay-done', reqId: message.reqId, ok: false, body: null }),
          )
          return true
        case 'ez:ready':
          // A fresh overlay knows nothing: its scale, and its own annotations.
          pushed.delete(guest.id)
          if (b) ports.guests.post(guest.id, { type: 'ez:viewport', ...b.viewportFor(), scoped: false })
          if (snapshot) pushAnnotations(snapshot)
          return false
        default:
          return false
      }
    },

    onKeyDown(e) {
      const board = activeBoard()
      // Only while the board, or nothing, has focus: Backspace on a focused
      // sidebar control must not delete the selected frames.
      const focus = document.activeElement
      if (!board || (focus && focus !== document.body && !board.el.contains(focus))) return false
      return board.onKeyDown(e)
    },

    onKeyUp(e) {
      activeBoard()?.onKeyUp(e)
    },

    setAnnotating(mode) {
      for (const b of boards.values()) b.setAnnotating(mode)
    },

    setPicking(on) {
      ports.stageWrap.classList.toggle('ez-picking', on)
    },

    get activeTab() {
      return shown
    },

    get activeName() {
      return activeBoard()?.name ?? null
    },

    batchView(appPage) {
      return shown && shown !== 'app' ? { tab: 'canvas', canvasId: shown } : { tab: 'app', page: appPage }
    },

    focusGuest(guestId) {
      const canvas = /^canvas:([0-9a-f]{12})\//.exec(guestId)?.[1]
      const tab = canvas ? asCanvasId(canvas) : 'app'
      if (tab && tab !== shown) select(tab)
    },

    frameTitle(ref) {
      const id = asCanvasId(ref.canvasId)
      return id ? boards.get(id)?.frameTitle(ref.frameId) ?? docs.get(id)?.frames.find((f) => f.id === ref.frameId)?.title : undefined
    },
  }
}
