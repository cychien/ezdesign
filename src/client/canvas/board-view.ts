/** One canvas on screen: the infinite board, its frames and their chrome. DOM
 *  per `names.ts`:
 *
 *      [ez-board] role=region data-canvas-id tabindex=0     the viewport
 *        [ez-board-world]                                   the one transformed element
 *          [ez-board-frame] role=group data-frame-id
 *            .ez-board-frame-head                           title and size
 *            iframe  src=FrameWire.src sandbox=FRAME_SANDBOX
 *      [ez-board-tools]  全部顯示 · 縮小 · [ez-board-zoom] 100% · 放大 · 重設縮放
 *
 *  What keeps forty frames smooth:
 *  - Pan and zoom write one `transform` on the world per animation frame from
 *    the camera; input handlers only update the camera and request that frame,
 *    and nothing reads layout - every rect is already in the model.
 *  - Iframes take no pointer events while a gesture runs, and none outside
 *    annotate mode unless one frame is made live by a double-click, so the
 *    wheel and drags never hit-test into forty documents.
 *  - `ez:viewport {zoom}` goes to the frames once, when a zoom settles.
 *  - Iframes are rationed by `planMounts`, re-planned when the camera settles
 *    and on each `load`; a mounted iframe is never moved in the DOM
 *    (re-inserting one reloads it) and stays mounted offscreen.
 *  - A changed `hash` reloads that one frame with `location.replace`, which
 *    leaves no history entry.
 *
 *  One `BoardView` per canvas, built on first show and kept (hidden) while
 *  another tab is active, so a tab switch never reloads an iframe and a pick
 *  armed in a frame is still armed on return. */

import type { Camera, FrameId, Size } from '../../canvas/types.js'
import type { CanvasWire, FrameWire } from '../../canvas/wire.js'
import { type CanvasGuestPort, canvasGuestId } from '../frame-registry.js'
import type { Mode } from '../guest-messages.js'
import { fitAll, panned, worldToScreen, worldTransform, zoomedAround } from './camera.js'
import { planMounts } from './mounting.js'
import { LABELS, TEST_IDS } from './names.js'

/** No `allow-top-navigation`: a frame cannot take the shell's tab anywhere.
 *  `allow-same-origin` keeps the frame's own origin (the frame host, never the
 *  shell's), so `localStorage` and CDN libraries that touch it work. */
export const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'

export interface BoardHost {
  guests: CanvasGuestPort
  /** Debounced after a gesture ends; persisted as the session's view. */
  saveCamera(camera: Camera): void
  /** Escape on the board, or a click on its empty background: stand down any
   *  pick or popup. */
  escape(): void
}

/** How long the camera has to stay still for a gesture to be over. */
const SETTLE_MS = 140
const SAVE_MS = 300
/** A wheel line or page, in pixels. */
const LINE_PX = 16
const ZOOM_STEP = 1.25
/** How strongly a pinch or Mod+wheel zooms per pixel of delta. */
const WHEEL_ZOOM = 0.0025

interface Card {
  frame: FrameWire
  el: HTMLElement
  head: HTMLElement
  iframe: HTMLIFrameElement | null
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export class BoardView {
  readonly el: HTMLElement
  private readonly world: HTMLElement
  private readonly empty: HTMLElement
  private readonly readout: HTMLElement
  private camera: Camera | null
  /** No saved camera and no gesture yet: the board keeps everything in view as
   *  frames arrive, so frames an agent adds one by one are all on screen. */
  private following: boolean
  private readonly cards = new Map<FrameId, Card>()
  private readonly mounted = new Set<FrameId>()
  private readonly loading = new Set<FrameId>()
  private stage: Size = { width: 0, height: 0 }
  private shown = false
  private frameRequested = 0
  private settleTimer = 0
  private saveTimer = 0
  /** The zoom the frames were last told, so a pan sends them nothing. */
  private toldZoom = 0
  private paintedZoom = 0
  private pan: { pointer: number; x: number; y: number; camera: Camera } | null = null
  private spaceHeld = false
  /** The frame a double-click made interactive, outside annotate mode. */
  private live: FrameId | null = null
  private readonly resize = new ResizeObserver(() => this.measure())

  constructor(
    private canvas: CanvasWire,
    private readonly host: BoardHost,
  ) {
    // The saved one, or null for a canvas never looked at: fit-all on first show.
    this.camera = canvas.camera ?? null
    this.following = !canvas.camera
    this.el = el('div', 'ez-board')
    this.el.dataset.testid = TEST_IDS.board
    this.el.dataset.canvasId = canvas.id
    this.el.setAttribute('role', 'region')
    this.el.tabIndex = 0
    this.el.hidden = true
    this.world = el('div', 'ez-board-world')
    this.world.dataset.testid = TEST_IDS.world
    this.empty = el('div', 'ez-board-empty', '還沒有任何 frame')

    const tools = el('div', 'ez-board-tools')
    tools.dataset.testid = TEST_IDS.tools
    const button = (label: string, text: string, hint: string, run: () => void) => {
      const b = el('button', 'ez-board-tool', text)
      b.setAttribute('aria-label', label)
      b.title = hint
      b.onclick = run
      return b
    }
    this.readout = el('span', 'ez-board-zoom', '100%')
    this.readout.dataset.testid = TEST_IDS.zoom
    this.readout.setAttribute('role', 'status')
    this.readout.setAttribute('aria-label', LABELS.zoomLevel)
    tools.append(
      button(LABELS.fitAll, LABELS.fitAll, `${LABELS.fitAll}（⇧1）`, () => this.fitAll()),
      button(LABELS.zoomOut, '−', LABELS.zoomOut, () => this.zoomBy(1 / ZOOM_STEP)),
      this.readout,
      button(LABELS.zoomIn, '+', LABELS.zoomIn, () => this.zoomBy(ZOOM_STEP)),
      button(LABELS.resetZoom, '1:1', `${LABELS.resetZoom}（⇧0）`, () => this.resetZoom()),
    )
    this.el.append(this.world, this.empty, tools)

    this.el.addEventListener('wheel', (e) => this.onBoardWheel(e), { passive: false })
    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.el.addEventListener('pointermove', (e) => this.onPointerMove(e))
    this.el.addEventListener('pointerup', (e) => this.endPan(e))
    this.el.addEventListener('pointercancel', (e) => this.endPan(e))
    this.el.addEventListener('dblclick', (e) => this.onDoubleClick(e))
    this.apply(canvas)
  }

  get name(): string {
    return this.canvas.name
  }

  /** A canvas from the daemon (first flush, SSE event, an answer), diffed by
   *  frame id: new cards are added in one fragment, moved ones get a new rect,
   *  gone ones leave the registry, changed hashes reload. */
  apply(canvas: CanvasWire): void {
    this.canvas = canvas
    this.el.setAttribute('aria-label', LABELS.board(canvas.name))
    const next = new Map(canvas.frames.map((f) => [f.id, f]))
    for (const [id, card] of this.cards) {
      if (next.has(id)) continue
      this.unmount(id)
      card.el.remove()
      this.cards.delete(id)
      if (this.live === id) this.live = null
    }
    const fresh = document.createDocumentFragment()
    canvas.frames.forEach((frame, z) => {
      const card = this.cards.get(frame.id)
      if (!card) {
        const made = this.card(frame)
        this.cards.set(frame.id, made)
        fresh.appendChild(made.el)
      } else {
        const reload = card.frame.hash !== frame.hash
        card.frame = frame
        this.place(card)
        if (reload && card.iframe) {
          this.loading.add(frame.id)
          card.iframe.contentWindow?.location.replace(frame.src)
        }
      }
      this.cards.get(frame.id)!.el.style.zIndex = String(z + 1)
    })
    this.world.appendChild(fresh)
    this.empty.hidden = canvas.frames.length > 0
    if (!this.shown) return
    if (this.following) {
      this.camera = this.fitCamera()
      this.requestPaint()
    }
    this.remount()
  }

  /** First time: measure once, fit-all if no camera was saved, plan mounts.
   *  Later: repaint; the frames never left. */
  show(): void {
    this.el.hidden = false
    this.shown = true
    this.resize.observe(this.el)
    this.measure()
    if (!this.camera) this.camera = this.fitCamera()
    this.requestPaint()
    this.remount()
  }

  /** `hidden`; frames stay mounted and registered. */
  hide(): void {
    this.el.hidden = true
    this.shown = false
    this.resize.unobserve(this.el)
  }

  /** The canvas was archived or deleted: unregister every guest, drop the
   *  element. The only path that destroys its iframes in bulk. */
  dispose(): void {
    for (const id of [...this.mounted]) this.unmount(id)
    this.resize.disconnect()
    window.clearTimeout(this.settleTimer)
    window.clearTimeout(this.saveTimer)
    cancelAnimationFrame(this.frameRequested)
    this.el.remove()
  }

  /** E/R on: frames take the pointer so the overlay annotates; off: the board
   *  has it. */
  setAnnotating(mode: Mode): void {
    this.el.classList.toggle('ez-annotating', mode !== 'off')
  }

  /** The frame a guest id names, when it is one of this board's. */
  frameOf(guestId: string): FrameWire | undefined {
    for (const card of this.cards.values()) {
      if (canvasGuestId({ canvasId: this.canvas.id, frameId: card.frame.id }) === guestId) return card.frame
    }
    return undefined
  }

  /** The registered guests of this board: its mounted frames. */
  guestIds(): string[] {
    return [...this.mounted].map((frameId) => canvasGuestId({ canvasId: this.canvas.id, frameId }))
  }

  frameTitle(frameId: string): string | undefined {
    return this.cards.get(frameId as FrameId)?.frame.title
  }

  /** What a freshly booted frame overlay is told about its scale. */
  viewportFor(): { zoom: number } {
    return { zoom: this.camera?.zoom ?? 1 }
  }

  /** Mod/ctrl wheel (and a pinch) from inside a frame: zoom around where the
   *  pointer is, mapped from that frame's viewport into the board's. A plain
   *  delta pans. */
  onGuestWheel(frame: FrameWire, e: { dx: number; dy: number; zoom: boolean; at?: { x: number; y: number } }): void {
    if (!this.camera) return
    if (!e.zoom || !e.at) {
      this.setCamera(panned(this.camera, -e.dx, -e.dy))
      return
    }
    const corner = worldToScreen(this.camera, { x: frame.rect.x, y: frame.rect.y })
    const at = { x: corner.x + e.at.x * this.camera.zoom, y: corner.y + e.at.y * this.camera.zoom }
    this.setCamera(zoomedAround(this.camera, Math.exp(-e.dy * WHEEL_ZOOM), at))
  }

  /** Board keys while the board has focus and no field does. True when consumed. */
  onKeyDown(e: KeyboardEvent): boolean {
    if (e.code === 'Space' && !e.repeat) {
      this.spaceHeld = true
      this.el.classList.add('ez-space')
      return true
    }
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'Digit1') {
      this.fitAll()
      return true
    }
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'Digit0') {
      this.resetZoom()
      return true
    }
    if (e.key === 'Escape' && this.live) {
      this.setLive(null)
      return true
    }
    return false
  }

  onKeyUp(e: KeyboardEvent): void {
    if (e.code !== 'Space') return
    this.spaceHeld = false
    this.el.classList.remove('ez-space')
  }

  fitAll(): void {
    this.measure()
    this.setCamera(this.fitCamera())
  }

  zoomBy(factor: number): void {
    if (!this.camera) return
    this.setCamera(zoomedAround(this.camera, factor, { x: this.stage.width / 2, y: this.stage.height / 2 }))
  }

  resetZoom(): void {
    if (!this.camera) return
    this.zoomBy(1 / this.camera.zoom)
  }

  // ------------------------------------------------------------------ cards

  private card(frame: FrameWire): Card {
    const node = el('div', 'ez-board-frame')
    node.dataset.testid = TEST_IDS.frame
    node.dataset.frameId = frame.id
    node.setAttribute('role', 'group')
    const head = el('div', 'ez-board-frame-head')
    const card: Card = { frame, el: node, head, iframe: null }
    node.append(head)
    this.place(card)
    return card
  }

  private place(card: Card): void {
    const { rect, title } = card.frame
    const label = LABELS.frame(title, rect.width, rect.height)
    card.el.setAttribute('aria-label', label)
    card.el.style.transform = `translate(${rect.x}px, ${rect.y}px)`
    card.el.style.width = `${rect.width}px`
    card.el.style.height = `${rect.height}px`
    card.head.replaceChildren(
      el('span', 'ez-board-frame-title', title),
      el('span', 'ez-board-frame-size', `${rect.width}×${rect.height}`),
    )
    if (card.iframe) card.iframe.title = label
  }

  private remount(): void {
    if (!this.camera || !this.shown || this.stage.width === 0) return
    const pinned = new Set<FrameId>(this.live ? [this.live] : [])
    const plan = planMounts(
      this.canvas.frames.map((f) => ({ id: f.id, rect: f.rect })),
      this.camera,
      this.stage,
      { mounted: this.mounted, loading: this.loading, pinned },
    )
    for (const id of plan.unmount) this.unmount(id)
    for (const id of plan.mount) this.mount(id)
  }

  private mount(id: FrameId): void {
    const card = this.cards.get(id)
    if (!card || card.iframe) return
    const iframe = el('iframe', 'ez-board-iframe')
    iframe.setAttribute('sandbox', FRAME_SANDBOX)
    iframe.title = LABELS.frame(card.frame.title, card.frame.rect.width, card.frame.rect.height)
    iframe.src = card.frame.src
    iframe.addEventListener('load', () => {
      this.loading.delete(id)
      this.remount()
    })
    card.iframe = iframe
    card.el.append(iframe)
    this.mounted.add(id)
    this.loading.add(id)
    const place = { canvasId: this.canvas.id, frameId: id }
    this.host.guests.add({
      kind: 'canvas',
      id: canvasGuestId(place),
      iframe,
      origin: new URL(card.frame.src).origin,
      place,
    })
  }

  private unmount(id: FrameId): void {
    const card = this.cards.get(id)
    this.host.guests.remove(canvasGuestId({ canvasId: this.canvas.id, frameId: id }))
    card?.iframe?.remove()
    if (card) card.iframe = null
    this.mounted.delete(id)
    this.loading.delete(id)
  }

  private setLive(id: FrameId | null): void {
    if (this.live) this.cards.get(this.live)?.el.classList.remove('ez-live')
    this.live = id
    if (id) this.cards.get(id)?.el.classList.add('ez-live')
  }

  // ----------------------------------------------------------------- camera

  private measure(): void {
    if (this.el.hidden) return
    const width = this.el.clientWidth
    const height = this.el.clientHeight
    if (width === this.stage.width && height === this.stage.height) return
    this.stage = { width, height }
    if (this.shown) this.remount()
  }

  private fitCamera(): Camera {
    return fitAll(
      this.canvas.frames.map((f) => f.rect),
      this.stage.width ? this.stage : { width: 1200, height: 800 },
    )
  }

  private setCamera(camera: Camera): void {
    this.following = false
    this.camera = camera
    this.el.classList.add('ez-moving')
    this.requestPaint()
    window.clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => this.settle(), SETTLE_MS)
  }

  private settle(): void {
    this.el.classList.remove('ez-moving')
    const camera = this.camera
    if (!camera) return
    if (camera.zoom !== this.toldZoom) {
      this.toldZoom = camera.zoom
      for (const id of this.mounted) {
        this.host.guests.post(canvasGuestId({ canvasId: this.canvas.id, frameId: id }), {
          type: 'ez:viewport',
          zoom: camera.zoom,
          scoped: false,
        })
      }
    }
    this.remount()
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.host.saveCamera(camera), SAVE_MS)
  }

  private requestPaint(): void {
    if (this.frameRequested) return
    this.frameRequested = requestAnimationFrame(() => {
      this.frameRequested = 0
      this.paintCamera()
    })
  }

  /** The one place the transform is written. */
  private paintCamera(): void {
    const camera = this.camera
    if (!camera) return
    this.world.style.transform = worldTransform(camera)
    if (camera.zoom !== this.paintedZoom) {
      this.paintedZoom = camera.zoom
      this.world.style.setProperty('--ez-zoom', String(camera.zoom))
      this.readout.textContent = `${Math.round(camera.zoom * 100)}%`
    }
  }

  // ------------------------------------------------------------------ input

  private boardPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const box = this.el.getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }

  private onBoardWheel(e: WheelEvent): void {
    if (!this.camera) return
    e.preventDefault()
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? this.stage.height : 1
    if (e.ctrlKey || e.metaKey) {
      this.setCamera(zoomedAround(this.camera, Math.exp(-e.deltaY * unit * WHEEL_ZOOM), this.boardPoint(e)))
    } else {
      this.setCamera(panned(this.camera, -e.deltaX * unit, -e.deltaY * unit))
    }
  }

  /** The background, or anywhere with Space held, pans. */
  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.camera) return
    const target = e.target as HTMLElement
    if (target.closest('.ez-board-tools')) return
    const background = target === this.el || target === this.world || target === this.empty
    if (!background && !this.spaceHeld) return
    if (background && !this.spaceHeld) {
      this.setLive(null)
      this.host.escape()
    }
    e.preventDefault()
    this.el.focus({ preventScroll: true })
    this.el.setPointerCapture(e.pointerId)
    this.pan = { pointer: e.pointerId, x: e.clientX, y: e.clientY, camera: this.camera }
    this.el.classList.add('ez-panning')
  }

  private onPointerMove(e: PointerEvent): void {
    const pan = this.pan
    if (!pan || e.pointerId !== pan.pointer) return
    this.setCamera(panned(pan.camera, e.clientX - pan.x, e.clientY - pan.y))
  }

  private endPan(e: PointerEvent): void {
    if (!this.pan || e.pointerId !== this.pan.pointer) return
    this.pan = null
    this.el.classList.remove('ez-panning')
  }

  /** A double-click on a frame hands it the pointer, to scroll it or try its
   *  controls; Escape or a click on the background hands it back. */
  private onDoubleClick(e: MouseEvent): void {
    const frame = (e.target as HTMLElement).closest<HTMLElement>('.ez-board-frame')
    const id = frame?.dataset.frameId as FrameId | undefined
    if (id && this.cards.get(id)?.iframe) this.setLive(id)
  }
}
