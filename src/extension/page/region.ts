import { type Point, isRegion, regionFrom } from '../../client/region.js'
import type { RegionChoice } from '../shared/messages.js'

const MARK = '#e56d41'

const STYLE = `
  :host { all: initial; }
  .layer { position: fixed; inset: 0; cursor: crosshair; touch-action: none; }
  .shade { position: fixed; background: oklch(0% 0 0 / 0.35); pointer-events: none; }
  .box { position: fixed; pointer-events: none; outline: 1.5px dashed ${MARK}; outline-offset: -1px; }
  .size {
    position: fixed; pointer-events: none; padding: 2px 6px; border-radius: 4px;
    background: #171717; color: #fff; white-space: nowrap;
    font: 500 11px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%); pointer-events: none;
    padding: 6px 12px; border-radius: 8px; background: #171717; color: #fff;
    font: 500 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', sans-serif;
  }
  [hidden] { display: none; }
`

const now = () => performance.timeOrigin + performance.now()
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

function place(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  el.style.width = `${Math.max(0, width)}px`
  el.style.height = `${Math.max(0, height)}px`
}

/** Resolves two frames after the overlay leaves, or `captureVisibleTab` still shows it. */
export function selectRegion(): Promise<RegionChoice> {
  const host = document.createElement('div')
  host.setAttribute('data-ez-capture', '')
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647'
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = STYLE
  const layer = document.createElement('div')
  layer.className = 'layer'
  const shade = () => {
    const el = document.createElement('div')
    el.className = 'shade'
    el.hidden = true
    return el
  }
  const [top, bottom, left, right] = [shade(), shade(), shade(), shade()]
  const shades = [top, bottom, left, right]
  const box = document.createElement('div')
  box.className = 'box'
  box.hidden = true
  const size = document.createElement('div')
  size.className = 'size'
  size.hidden = true
  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = '拖曳框出要存的區域，點一下存整個畫面，Esc 取消'
  root.append(style, layer, ...shades, box, size, hint)
  document.documentElement.append(host)

  return new Promise((resolve) => {
    let from: Point | null = null
    let settled = false

    const draw = (to: Point) => {
      const r = regionFrom(from!, to)
      const dragging = isRegion(r)
      for (const shade of shades) shade.hidden = !dragging
      box.hidden = size.hidden = !dragging
      hint.hidden = dragging || hint.hidden
      if (!dragging) return
      place(top, 0, 0, innerWidth, r.y)
      place(bottom, 0, r.y + r.height, innerWidth, innerHeight - r.y - r.height)
      place(left, 0, r.y, r.x, r.height)
      place(right, r.x + r.width, r.y, innerWidth - r.x - r.width, r.height)
      place(box, r.x, r.y, r.width, r.height)
      size.textContent = `${r.width} × ${r.height}`
      const below = r.y + r.height + 28 < innerHeight
      size.style.left = `${r.x}px`
      size.style.top = `${below ? r.y + r.height + 6 : Math.max(0, r.y - 26)}px`
    }

    const finish = async (choice: RegionChoice) => {
      if (settled) return
      settled = true
      removeEventListener('keydown', onKey, true)
      removeEventListener('wheel', block, true)
      removeEventListener('touchmove', block, true)
      host.remove()
      await frame()
      await frame()
      resolve(choice)
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      void finish({ type: 'cancelled' })
    }
    const block = (event: Event) => event.preventDefault()

    layer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      layer.setPointerCapture(event.pointerId)
      from = { x: event.clientX, y: event.clientY }
    })
    layer.addEventListener('pointermove', (event) => {
      if (from) draw({ x: event.clientX, y: event.clientY })
    })
    layer.addEventListener('pointerup', (event) => {
      if (!from) return
      const pickedAt = now()
      const rect = regionFrom(from, { x: event.clientX, y: event.clientY })
      const viewport = { width: innerWidth, height: innerHeight }
      void finish(isRegion(rect) ? { type: 'rect', rect, viewport, pickedAt } : { type: 'viewport', viewport, pickedAt })
    })
    addEventListener('keydown', onKey, true)
    addEventListener('wheel', block, { capture: true, passive: false })
    addEventListener('touchmove', block, { capture: true, passive: false })
  })
}
