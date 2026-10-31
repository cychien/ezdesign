/** One canvas on screen: the infinite board, its frames and their chrome. DOM
 *  per `names.ts`:
 *
 *      [ez-board] role=region data-canvas-id tabindex=0     the viewport
 *        [ez-board-world]                                   the one transformed element
 *          [ez-board-frame] role=group data-frame-id aria-selected
 *            iframe  src=FrameWire.src sandbox=FRAME_SANDBOX
 *          [ez-guide] data-axis=x|y                         while aligned
 *        .ez-board-heads                                    screen pixels, not scaled
 *          .ez-board-frame-head data-frame-id               title; a drag handle
 *      [ez-board-tools]  縮小 · [ez-board-zoom] 100% · 放大
 *
 *  What keeps forty frames smooth:
 *  - Pan and zoom write one `transform` on the world per animation frame from
 *    the camera; input handlers only update the camera and request that frame,
 *    and nothing reads layout - every rect is already in the model. A frame
 *    being dragged writes its own transform the same way. Frame heads are the
 *    exception to the one transform: text in a layer rescaled every frame is
 *    re-rasterized at a new scale each frame and visibly flickers, so each head
 *    is placed in whole screen pixels instead (`paintHeads`).
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
 *  A drag on the background draws a selection box over every frame it touches.
 *  A drag that reaches the board's edge pans it (`edgePan`) for as long as the
 *  pointer stays there, the frames or the box riding along under the pointer.
 *
 *  Edits are applied at once and sent one request at a time; what is still in
 *  flight is re-applied over every canvas the daemon pushes (`withPending`).
 *
 *  One `BoardView` per canvas, built on first show and kept (hidden) while
 *  another tab is active, so a tab switch never reloads an iframe and a pick
 *  armed in a frame is still armed on return. */

import AiSketchIcon from '@hugeicons/core-free-icons/AiSketchIcon'
import MinusIcon from '@hugeicons/core-free-icons/MinusIcon'
import PlusIcon from '@hugeicons/core-free-icons/PlusIcon'
import {
  type AssetName,
  type Camera,
  type FrameId,
  MAX_FRAME_TITLE,
  type Point,
  type Rect,
  type Size,
  mintFrameId,
} from '../../canvas/types.js'
import { boundsOf, imageFrameSize } from '../../canvas/place.js'
import type { CanvasWire, FrameWire, LayoutOp } from '../../canvas/wire.js'
import { type CanvasGuestPort, canvasGuestId } from '../frame-registry.js'
import { type IconNode, icon } from '../icon.js'
import type { Mode } from '../guest-messages.js'
import { boxBetween, edgePan, fitAll, intersects, panned, screenToWorld, worldToScreen, worldTransform, zoomedAround } from './camera.js'
import { type Guide, snapMove } from './guides.js'
import {
  type BoardEdit,
  EditHistory,
  type EditStep,
  planDuplicate,
  planImages,
  planMove,
  planRemove,
  withPending,
} from './history.js'
import { planMounts } from './mounting.js'
import { LABELS, TEST_IDS } from './names.js'

/** No `allow-top-navigation`: a frame cannot take the shell's tab anywhere.
 *  `allow-same-origin` keeps the frame's own origin (the frame host, never the
 *  shell's), so `localStorage` and CDN libraries that touch it work. */
export const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'

export interface BoardHost {
  guests: CanvasGuestPort
  /** One request: `POST /ops` or `POST /frames`. Resolves with the canvas the
   *  daemon answered, or null on refusal (the next pushed canvas, without the
   *  edit pending, rolls it back). */
  send(edit: BoardEdit): Promise<CanvasWire | null>
  /** A pasted image's bytes, stored on the canvas. Null on refusal. */
  storeImage(image: Blob): Promise<AssetName | null>
  /** Debounced after a gesture ends; persisted as the session's view. */
  saveCamera(camera: Camera): void
  /** Escape on the board, or a click on its empty background: stand down any
   *  pick or popup. */
  escape(): void
  /** A frame's title clicked while a pick is out: the whole frame answers it. */
  chooseFrame(frame: FrameWire): void
}

/** How long the camera has to stay still for a gesture to be over. */
const SETTLE_MS = 140
const SAVE_MS = 300
/** A wheel line or page, in pixels. */
const LINE_PX = 16
const ZOOM_STEP = 1.25
/** How strongly a pinch or Mod+wheel zooms per pixel of delta. */
const WHEEL_ZOOM = 0.0025
/** How far the pointer has to travel, in screen pixels, before a press on a
 *  frame becomes a drag rather than a click. */
const DRAG_PX = 3
/** The longest step an edge pan takes, so a stalled frame does not jump. */
const MAX_PAN_STEP_S = 1 / 30

interface Card {
  frame: FrameWire
  el: HTMLElement
  head: HTMLElement
  iframe: HTMLIFrameElement | null
}

type Gesture =
  | { t: 'pan'; pointer: number; x: number; y: number; camera: Camera }
  | {
      t: 'move'
      pointer: number
      x: number
      y: number
      /** Board-relative: where the press was, and where the pointer is now. */
      from: Point
      at: Point
      camera: Camera
      ids: ReadonlySet<FrameId>
      started: boolean
      dx: number
      dy: number
      /** A shift-press on a frame already selected leaves the selection alone
       *  until the press turns out to be a click, which then deselects it. */
      toggleOnClick: FrameId | null
    }
  | {
      t: 'marquee'
      pointer: number
      /** The press in world coordinates, so the box stays put while the camera pans. */
      origin: Point
      /** Board-relative: where the press was, and where the pointer is now. */
      from: Point
      at: Point
      /** What a shift-press keeps selected. */
      base: ReadonlySet<FrameId>
      started: boolean
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
  private readonly heads: HTMLElement
  private readonly marquee: HTMLElement
  private readonly guides: HTMLElement
  private readonly empty: HTMLElement
  private readonly readout: HTMLElement
  private camera: Camera | null
  /** No saved camera and no gesture yet: the board keeps everything in view as
   *  frames arrive, so frames an agent adds one by one are all on screen. */
  private following: boolean
  /** The frames as shown: the daemon's latest with pending edits on top. */
  private frames: FrameWire[] = []
  private readonly cards = new Map<FrameId, Card>()
  private readonly mounted = new Set<FrameId>()
  private picking = false
  /** The frame whose title the pointer is over while picking. */
  private pickTarget: FrameId | null = null
  private readonly loading = new Set<FrameId>()
  private selection = new Set<FrameId>()
  private readonly history = new EditHistory()
  /** Applied here, not yet answered: re-applied over every canvas that arrives. */
  private pending: BoardEdit[] = []
  private sending = false
  private stage: Size = { width: 0, height: 0 }
  private shown = false
  private frameRequested = 0
  private edgePanRequested = 0
  private edgePanAt = 0
  private settleTimer = 0
  private saveTimer = 0
  /** The zoom the frames were last told, so a pan sends them nothing. */
  private toldZoom = 0
  private paintedZoom = 0
  private gesture: Gesture | null = null
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
    this.guides = el('div', 'ez-guides')
    this.world.append(this.guides)
    this.heads = el('div', 'ez-board-heads')
    this.marquee = el('div', 'ez-board-marquee')
    this.marquee.hidden = true
    this.empty = el('div', 'ez-board-empty')
    this.empty.append(icon(AiSketchIcon as IconNode, 64))

    const tools = el('div', 'ez-board-tools')
    tools.dataset.testid = TEST_IDS.tools
    const button = (label: string, glyph: IconNode, run: () => void) => {
      const b = el('button', 'ez-board-tool')
      b.append(icon(glyph, 14))
      b.setAttribute('aria-label', label)
      b.title = label
      b.onclick = run
      return b
    }
    this.readout = el('span', 'ez-board-zoom', '100%')
    this.readout.dataset.testid = TEST_IDS.zoom
    this.readout.setAttribute('role', 'status')
    this.readout.setAttribute('aria-label', LABELS.zoomLevel)
    tools.append(
      button(LABELS.zoomOut, MinusIcon as IconNode, () => this.zoomBy(1 / ZOOM_STEP)),
      this.readout,
      button(LABELS.zoomIn, PlusIcon as IconNode, () => this.zoomBy(ZOOM_STEP)),
    )
    this.el.append(this.world, this.heads, this.marquee, this.empty, tools)

    this.el.addEventListener('wheel', (e) => this.onBoardWheel(e), { passive: false })
    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.el.addEventListener('pointermove', (e) => this.onPointerMove(e))
    this.el.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.el.addEventListener('pointercancel', (e) => this.onPointerUp(e, true))
    this.el.addEventListener('dblclick', (e) => this.onDoubleClick(e))
    this.heads.addEventListener('pointerover', (e) => this.onHeadOver(e))
    this.heads.addEventListener('pointerleave', () => this.markPickTarget(null))
    this.apply(canvas)
  }

  get name(): string {
    return this.canvas.name
  }

  /** A canvas from the daemon (first flush, SSE event, an answer). */
  apply(canvas: CanvasWire): void {
    this.canvas = canvas
    this.el.setAttribute('aria-label', LABELS.board(canvas.name))
    this.render()
  }

  /** Diffed by frame id over `withPending`: new cards are added in one fragment,
   *  moved ones get a new rect, gone ones leave the registry, changed hashes
   *  reload. The selection drops ids that no longer exist. */
  private render(): void {
    this.frames = withPending(this.canvas, this.pending)
    const next = new Map(this.frames.map((f) => [f.id, f]))
    for (const [id, card] of this.cards) {
      if (next.has(id)) continue
      this.unmount(id)
      card.el.remove()
      card.head.remove()
      this.cards.delete(id)
      this.selection.delete(id)
      if (this.live === id) this.live = null
    }
    const fresh = document.createDocumentFragment()
    this.frames.forEach((frame, z) => {
      const card = this.cards.get(frame.id)
      if (!card) {
        const made = this.card(frame)
        this.cards.set(frame.id, made)
        fresh.appendChild(made.el)
      } else {
        // The src carries the revision and the frame's own id: a new document,
        // or a duplicate's real copy replacing its source's stand-in.
        const reload = card.frame.src !== frame.src
        card.frame = frame
        this.place(card)
        if (reload && card.iframe) {
          this.loading.add(frame.id)
          card.iframe.contentWindow?.location.replace(frame.src)
        }
      }
      this.cards.get(frame.id)!.el.style.zIndex = String(z + 1)
    })
    this.world.insertBefore(fresh, this.guides)
    this.empty.hidden = this.frames.length > 0
    this.paintSelection()
    this.paintHeads()
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
    cancelAnimationFrame(this.edgePanRequested)
    this.el.remove()
  }

  /** E/R on: frames take the pointer so the overlay annotates; off: the board
   *  has it. */
  setAnnotating(mode: Mode): void {
    this.el.classList.toggle('ez-annotating', mode !== 'off')
  }

  /** While a pick is out, a frame's title answers it with the whole frame,
   *  rather than selecting the frame to drag. */
  setPicking(on: boolean): void {
    this.picking = on
    this.el.classList.toggle('ez-picking-frames', on)
    if (!on) this.markPickTarget(null)
  }

  private onHeadOver(e: PointerEvent): void {
    if (!this.picking) return
    const head = (e.target as HTMLElement).closest<HTMLElement>('.ez-board-frame-head')
    this.markPickTarget((head?.dataset.frameId as FrameId | undefined) ?? null)
  }

  private markPickTarget(id: FrameId | null): void {
    if (id === this.pickTarget) return
    if (this.pickTarget) this.cards.get(this.pickTarget)?.el.classList.remove('ez-pick-target')
    this.pickTarget = id
    if (id) this.cards.get(id)?.el.classList.add('ez-pick-target')
  }

  /** The frame a guest id names, when it is one of this board's. */
  frameOf(guestId: string): FrameWire | undefined {
    return this.frames.find((f) => canvasGuestId({ canvasId: this.canvas.id, frameId: f.id }) === guestId)
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

  /** Board keys while the board is showing and no field has focus. True when
   *  consumed. */
  onKeyDown(e: KeyboardEvent): boolean {
    const mod = e.metaKey || e.ctrlKey
    if (e.code === 'Space' && !e.repeat && !mod) {
      this.spaceHeld = true
      this.el.classList.add('ez-space')
      return true
    }
    if (e.shiftKey && !mod && e.code === 'Digit1') {
      this.fitAll()
      return true
    }
    if (e.shiftKey && !mod && e.code === 'Digit0') {
      this.resetZoom()
      return true
    }
    if (mod && e.code === 'KeyZ') {
      this.undoRedo(e.shiftKey ? 'redo' : 'undo')
      return true
    }
    if (mod && !e.shiftKey && e.code === 'KeyA') {
      this.select(new Set(this.frames.map((f) => f.id)))
      return true
    }
    if (mod && !e.shiftKey && e.code === 'KeyD') {
      this.duplicateSelection()
      return true
    }
    if (!mod && (e.key === 'Backspace' || e.key === 'Delete') && this.selection.size) {
      this.commit(planRemove(this.selection))
      this.select(new Set())
      return true
    }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
    if (arrow && !mod && this.selection.size) {
      const step = e.shiftKey ? 10 : 1
      this.commit(planMove(this.frames, this.selection, arrow[0]! * step, arrow[1]! * step, { nudge: true }))
      return true
    }
    if (e.key === 'Escape' && (this.live || this.selection.size)) {
      this.setLive(null)
      this.select(new Set())
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

  // ------------------------------------------------------------------ edits

  /** Apply locally, record in history, queue; send when the previous request
   *  is answered. */
  private commit(step: EditStep): void {
    this.following = false
    this.history.push(step, performance.now())
    this.enqueue(step.apply)
  }

  private enqueue(edits: BoardEdit[]): void {
    this.pending.push(...edits)
    this.render()
    void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.sending) return
    this.sending = true
    while (this.pending.length) {
      const answer = await this.host.send(this.pending[0]!)
      this.pending.shift()
      if (answer) this.canvas = answer
      this.render()
    }
    this.sending = false
  }

  private undoRedo(which: 'undo' | 'redo'): void {
    const ops: LayoutOp[] | null = which === 'undo' ? this.history.undo() : this.history.redo()
    if (ops) this.enqueue([{ t: 'ops', ops }])
  }

  private duplicateSelection(): void {
    if (!this.selection.size) return
    const step = planDuplicate(this.frames, this.selection, () => mintFrameId((b) => crypto.getRandomValues(b)))
    this.commit(step)
    this.select(new Set(step.copies))
  }

  /** Pasted images, each at its natural size, in a row centred on the view and
   *  selected, as a paste lands in Figma. */
  async pasteImages(files: readonly File[]): Promise<void> {
    const stored = await Promise.all(
      files.map(async (file) => {
        const natural = await naturalSize(file)
        const asset = natural && (await this.host.storeImage(file))
        return natural && asset ? { asset, title: imageTitle(file), size: imageFrameSize(natural) } : null
      }),
    )
    const images = stored.filter((image) => image !== null)
    if (!images.length || !this.camera) return
    const center = screenToWorld(this.camera, { x: this.stage.width / 2, y: this.stage.height / 2 })
    const step = planImages(images, center, () => mintFrameId((b) => crypto.getRandomValues(b)))
    this.commit(step)
    this.select(new Set(step.added))
  }

  private select(ids: Set<FrameId>): void {
    this.selection = ids
    this.paintSelection()
  }

  private paintSelection(): void {
    for (const [id, card] of this.cards) {
      card.el.setAttribute('aria-selected', String(this.selection.has(id)))
      card.head.classList.toggle('ez-selected', this.selection.has(id))
    }
  }

  /** Each head sits on its frame's top-left corner in whole screen pixels, as
   *  wide as the frame is on screen. A frame mid-drag takes its head along. */
  private paintHeads(): void {
    const camera = this.camera
    if (!camera) return
    const drag = this.gesture?.t === 'move' ? this.gesture : null
    for (const card of this.cards.values()) {
      const { id, rect } = card.frame
      const dragged = drag?.ids.has(id)
      const at = worldToScreen(camera, { x: rect.x + (dragged ? drag!.dx : 0), y: rect.y + (dragged ? drag!.dy : 0) })
      card.head.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translateY(-100%)`
      card.head.style.maxWidth = `${Math.round(rect.width * camera.zoom)}px`
    }
  }

  private paintGuides(guides: Guide[]): void {
    this.guides.replaceChildren(
      ...guides.map((g) => {
        const line = el('div', 'ez-guide')
        line.dataset.testid = TEST_IDS.guide
        line.dataset.axis = g.axis
        if (g.axis === 'x') {
          line.style.transform = `translate(${g.at}px, ${g.from}px)`
          line.style.height = `${g.to - g.from}px`
        } else {
          line.style.transform = `translate(${g.from}px, ${g.at}px)`
          line.style.width = `${g.to - g.from}px`
        }
        return line
      }),
    )
  }

  // ------------------------------------------------------------------ cards

  private card(frame: FrameWire): Card {
    const node = el('div', 'ez-board-frame')
    node.dataset.testid = TEST_IDS.frame
    node.dataset.frameId = frame.id
    node.setAttribute('role', 'group')
    const head = el('div', 'ez-board-frame-head')
    head.dataset.frameId = frame.id
    const card: Card = { frame, el: node, head, iframe: null }
    this.heads.append(head)
    this.place(card)
    return card
  }

  private place(card: Card, rect: Rect = card.frame.rect): void {
    const { title } = card.frame
    const label = LABELS.frame(title, rect.width, rect.height)
    card.el.setAttribute('aria-label', label)
    card.el.style.transform = `translate(${rect.x}px, ${rect.y}px)`
    card.el.style.width = `${rect.width}px`
    card.el.style.height = `${rect.height}px`
    card.head.replaceChildren(el('span', 'ez-board-frame-title', title))
    if (card.iframe) card.iframe.title = label
  }

  private remount(): void {
    if (!this.camera || !this.shown || this.stage.width === 0) return
    const pinned = new Set<FrameId>([...(this.live ? [this.live] : []), ...this.selection])
    const plan = planMounts(
      this.frames.map((f) => ({ id: f.id, rect: f.rect })),
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
      this.frames.map((f) => f.rect),
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

  /** The one place the world's transform is written. */
  private paintCamera(): void {
    const camera = this.camera
    if (!camera) return
    this.world.style.transform = worldTransform(camera)
    this.paintHeads()
    if (camera.zoom !== this.paintedZoom) {
      this.paintedZoom = camera.zoom
      this.world.style.setProperty('--ez-zoom', String(camera.zoom))
      this.readout.textContent = `${Math.round(camera.zoom * 100)}%`
    }
  }

  // ------------------------------------------------------------------ input

  private boardPoint(e: { clientX: number; clientY: number }): Point {
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
    if (this.gesture?.t === 'move' && this.gesture.started) this.dragTo(this.gesture)
    if (this.gesture?.t === 'marquee' && this.gesture.started) this.paintMarquee(this.gesture)
  }

  /** Space held or the middle button pans; the background draws a selection
   *  box; a frame's head or body selects and drags it. */
  private onPointerDown(e: PointerEvent): void {
    if ((e.button !== 0 && e.button !== 1) || !this.camera || this.gesture) return
    const target = e.target as HTMLElement
    if (target.closest('.ez-board-tools')) return
    // The user has the board now: frames that arrive no longer move the camera.
    this.following = false
    const start = (gesture: Gesture) => {
      e.preventDefault()
      this.el.focus({ preventScroll: true })
      this.el.setPointerCapture(e.pointerId)
      this.gesture = gesture
    }
    if (this.spaceHeld || e.button === 1) {
      start({ t: 'pan', pointer: e.pointerId, x: e.clientX, y: e.clientY, camera: this.camera })
      this.el.classList.add('ez-panning')
      return
    }
    const pickedHead = this.picking ? target.closest<HTMLElement>('.ez-board-frame-head') : null
    if (pickedHead) {
      e.preventDefault()
      const card = this.cards.get(pickedHead.dataset.frameId as FrameId)
      if (card) this.host.chooseFrame(card.frame)
      return
    }
    const cardEl = target.closest<HTMLElement>('.ez-board-frame, .ez-board-frame-head')
    const id = cardEl?.dataset.frameId as FrameId | undefined
    if (id && id !== this.live) {
      let toggleOnClick: FrameId | null = null
      if (e.shiftKey) {
        if (this.selection.has(id)) toggleOnClick = id
        else this.select(new Set([...this.selection, id]))
      } else if (!this.selection.has(id)) {
        this.select(new Set([id]))
      }
      const from = this.boardPoint(e)
      start({
        t: 'move',
        pointer: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        from,
        at: from,
        camera: this.camera,
        ids: new Set(this.selection),
        started: false,
        dx: 0,
        dy: 0,
        toggleOnClick,
      })
      return
    }
    if (!id) {
      this.setLive(null)
      if (!e.shiftKey) this.select(new Set())
      this.host.escape()
      const from = this.boardPoint(e)
      start({
        t: 'marquee',
        pointer: e.pointerId,
        origin: screenToWorld(this.camera, from),
        from,
        at: from,
        base: new Set(this.selection),
        started: false,
      })
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const g = this.gesture
    if (!g || e.pointerId !== g.pointer || !this.camera) return
    if (g.t === 'pan') {
      this.setCamera(panned(g.camera, e.clientX - g.x, e.clientY - g.y))
      return
    }
    if (g.t === 'marquee') {
      g.at = this.boardPoint(e)
      if (!g.started && Math.hypot(g.at.x - g.from.x, g.at.y - g.from.y) < DRAG_PX) return
      g.started = true
      this.paintMarquee(g)
      this.startEdgePan()
      return
    }
    if (!g.started) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_PX) return
      g.started = true
      this.el.classList.add('ez-arranging')
    }
    g.at = { x: g.from.x + e.clientX - g.x, y: g.from.y + e.clientY - g.y }
    this.dragTo(g)
    this.startEdgePan()
  }

  /** The dragged frames under the pointer, wherever the camera has gone since
   *  the press. */
  private dragTo(g: Extract<Gesture, { t: 'move' }>): void {
    const camera = this.camera
    if (!camera) return
    const moving = this.frames.filter((f) => g.ids.has(f.id))
    const box = boundsOf(moving.map((f) => f.rect))
    if (!box) return
    const grabbed = screenToWorld(g.camera, g.from)
    const pointer = screenToWorld(camera, g.at)
    const raw = { ...box, x: box.x + pointer.x - grabbed.x, y: box.y + pointer.y - grabbed.y }
    const others = this.frames.filter((f) => !g.ids.has(f.id)).map((f) => f.rect)
    const snapped = snapMove(raw, others, camera.zoom)
    g.dx = Math.round(snapped.rect.x - box.x)
    g.dy = Math.round(snapped.rect.y - box.y)
    for (const f of moving) {
      this.cards.get(f.id)!.el.style.transform = `translate(${f.rect.x + g.dx}px, ${f.rect.y + g.dy}px)`
    }
    this.paintHeads()
    this.paintGuides(snapped.guides)
  }

  /** Selects every frame the box touches, on top of what a shift-press kept. */
  private paintMarquee(g: Extract<Gesture, { t: 'marquee' }>): void {
    const camera = this.camera
    if (!camera) return
    const box = boxBetween(g.origin, screenToWorld(camera, g.at))
    const hits = this.frames.filter((f) => intersects(box, f.rect)).map((f) => f.id)
    this.select(new Set([...g.base, ...hits]))
    const screen = boxBetween(worldToScreen(camera, g.origin), g.at)
    this.marquee.style.transform = `translate(${screen.x}px, ${screen.y}px)`
    this.marquee.style.width = `${screen.width}px`
    this.marquee.style.height = `${screen.height}px`
    this.marquee.hidden = false
  }

  private startEdgePan(): void {
    if (this.edgePanRequested) return
    this.edgePanAt = performance.now()
    this.edgePanRequested = requestAnimationFrame((now) => this.edgePanStep(now))
  }

  /** One frame of a drag held at the edge: pan, then carry the frames along.
   *  Stops by itself once the pointer leaves the edge or the drag ends. */
  private edgePanStep(now: number): void {
    this.edgePanRequested = 0
    const g = this.gesture
    if (!g || g.t === 'pan' || !g.started || !this.camera) return
    const speed = edgePan(g.at, g.from, this.stage)
    if (!speed.x && !speed.y) return
    const dt = Math.min(MAX_PAN_STEP_S, Math.max(0, now - this.edgePanAt) / 1000)
    this.edgePanAt = now
    this.setCamera(panned(this.camera, -speed.x * dt, -speed.y * dt))
    if (g.t === 'move') this.dragTo(g)
    else this.paintMarquee(g)
    this.edgePanRequested = requestAnimationFrame((next) => this.edgePanStep(next))
  }

  private onPointerUp(e: PointerEvent, cancelled = false): void {
    const g = this.gesture
    if (!g || e.pointerId !== g.pointer) return
    this.gesture = null
    cancelAnimationFrame(this.edgePanRequested)
    this.edgePanRequested = 0
    this.el.classList.remove('ez-panning', 'ez-arranging')
    this.paintGuides([])
    this.marquee.hidden = true
    if (g.t !== 'move') return
    if (!g.started) {
      if (g.toggleOnClick) this.select(new Set([...this.selection].filter((id) => id !== g.toggleOnClick)))
      return
    }
    if (cancelled || (g.dx === 0 && g.dy === 0)) {
      this.render()
      return
    }
    this.commit(planMove(this.frames, g.ids, g.dx, g.dy))
  }

  /** A double-click on a frame hands it the pointer, to scroll it or try its
   *  controls; Escape or a click on the background hands it back. */
  private onDoubleClick(e: MouseEvent): void {
    const frame = (e.target as HTMLElement).closest<HTMLElement>('.ez-board-frame, .ez-board-frame-head')
    const id = frame?.dataset.frameId as FrameId | undefined
    if (id && this.cards.get(id)?.iframe) this.setLive(id)
  }
}

async function naturalSize(image: Blob): Promise<Size | null> {
  const bitmap = await createImageBitmap(image).catch(() => null)
  if (bitmap) {
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  }
  // SVG has no bitmap decode; an `<img>` takes it.
  const url = URL.createObjectURL(image)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The file's name without its extension: `image` for a copied screenshot. */
function imageTitle(file: File): string {
  const stem = file.name.replace(/\.[^.]*$/, '').trim()
  return [...(stem || '圖片')].slice(0, MAX_FRAME_TITLE).join('')
}
