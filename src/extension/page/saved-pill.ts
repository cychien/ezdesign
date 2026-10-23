const SHOWN_MS = 1600

const STYLE = `
  :host { all: initial; }
  .pill {
    position: fixed; top: 16px; left: 50%; z-index: 2147483647;
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px 6px 9px; border-radius: 8px; color: #fff; pointer-events: none;
    background: oklch(0% 0 0 / 0.78); backdrop-filter: blur(16px) saturate(1.6);
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.1), 0 4px 16px oklch(0% 0 0 / 0.16);
    font: 500 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', sans-serif;
    transform: translateX(-50%);
    animation: in 0.22s cubic-bezier(0.23, 1, 0.32, 1) both;
  }
  .pill[data-leaving] { animation: out 0.18s cubic-bezier(0.23, 1, 0.32, 1) both; }
  svg { flex-shrink: 0; }
  @keyframes in { from { opacity: 0; transform: translate(-50%, -6px) scale(0.96); } }
  @keyframes out { to { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    @keyframes in { from { opacity: 0; } }
  }
`

const SVG = 'http://www.w3.org/2000/svg'

/** Built node by node: `innerHTML` throws on pages that enforce Trusted Types. */
function check(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [name, value] of Object.entries({ width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' })) {
    svg.setAttribute(name, value)
  }
  const path = document.createElementNS(SVG, 'path')
  for (const [name, value] of Object.entries({
    d: 'M5 12.5 10 17.5 19 7',
    stroke: 'currentColor',
    'stroke-width': '2.2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })) {
    path.setAttribute(name, value)
  }
  svg.append(path)
  return svg
}

let shown: { host: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

export function showSavedPill(): void {
  if (shown) {
    clearTimeout(shown.timer)
    shown.host.remove()
  }
  const host = document.createElement('div')
  host.setAttribute('data-ez-capture-saved', '')
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647'
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = STYLE
  const pill = document.createElement('div')
  pill.className = 'pill'
  pill.setAttribute('role', 'status')
  const label = document.createElement('span')
  label.textContent = '已儲存'
  pill.append(check(), label)
  root.append(style, pill)
  document.documentElement.append(host)
  const timer = setTimeout(() => {
    pill.dataset.leaving = ''
    pill.addEventListener(
      'animationend',
      () => {
        host.remove()
        if (shown?.host === host) shown = null
      },
      { once: true },
    )
  }, SHOWN_MS)
  shown = { host, timer }
}

/** Resolves once the pill is off screen, so a capture of the tab never shows it. */
export async function clearSavedPill(): Promise<void> {
  if (!shown) return
  clearTimeout(shown.timer)
  shown.host.remove()
  shown = null
  await frame()
  await frame()
}
