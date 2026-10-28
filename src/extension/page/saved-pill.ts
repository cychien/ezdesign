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
  .spin { animation: spin 0.9s linear infinite; }
  .pill { font-variant-numeric: tabular-nums; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes in { from { opacity: 0; transform: translate(-50%, -6px) scale(0.96); } }
  @keyframes out { to { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    @keyframes in { from { opacity: 0; } }
    .spin { animation: none; }
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

type Tone = 'working' | 'done' | 'error'

const LINGER_MS: Record<Exclude<Tone, 'working'>, number> = { done: SHOWN_MS, error: 4000 }

function spinner(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [name, value] of Object.entries({ width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', class: 'spin' })) {
    svg.setAttribute(name, value)
  }
  const arc = document.createElementNS(SVG, 'path')
  for (const [name, value] of Object.entries({ d: 'M21 12a9 9 0 1 1-6.2-8.56', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' })) {
    arc.setAttribute(name, value)
  }
  svg.append(arc)
  return svg
}

function alert(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [name, value] of Object.entries({ width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' })) {
    svg.setAttribute(name, value)
  }
  const mark = document.createElementNS(SVG, 'path')
  for (const [name, value] of Object.entries({ d: 'M12 7v6M12 17h.01', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round' })) {
    mark.setAttribute(name, value)
  }
  svg.append(mark)
  return svg
}

const ICONS: Record<Tone, () => SVGSVGElement> = { working: spinner, done: check, error: alert }

let shown: { host: HTMLElement; pill: HTMLElement; label: HTMLElement; tone: Tone; timer: ReturnType<typeof setTimeout> | null } | null = null

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

function leave(current: NonNullable<typeof shown>): void {
  current.pill.dataset.leaving = ''
  current.pill.addEventListener(
    'animationend',
    () => {
      current.host.remove()
      if (shown === current) shown = null
    },
    { once: true },
  )
}

export function showPill(text: string, tone: Tone): void {
  if (shown && !shown.pill.dataset.leaving) {
    if (shown.timer) clearTimeout(shown.timer)
    shown.label.textContent = text
    if (shown.tone !== tone) shown.pill.firstElementChild!.replaceWith(ICONS[tone]())
    shown.tone = tone
  } else {
    if (shown) shown.host.remove()
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
    label.textContent = text
    pill.append(ICONS[tone](), label)
    root.append(style, pill)
    document.documentElement.append(host)
    shown = { host, pill, label, tone, timer: null }
  }
  const current = shown!
  current.timer = tone === 'working' ? null : setTimeout(() => leave(current), LINGER_MS[tone])
}

export function showSavedPill(): void {
  showPill('已儲存', 'done')
}

/** Resolves once the pill is off screen, so a capture of the tab never shows it. */
export async function clearSavedPill(): Promise<void> {
  if (!shown) return
  if (shown.timer) clearTimeout(shown.timer)
  shown.host.remove()
  shown = null
  await frame()
  await frame()
}
