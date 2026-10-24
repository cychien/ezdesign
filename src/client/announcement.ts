import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import type { AnnouncementsSeenWire } from '../announcement-wire.js'
import { type IconNode, icon } from './icon.js'

export interface Announcement {
  /** Never reused: a dismissal is remembered under it. */
  id: string
  /** Only shown through `?announcement=<id>`, for previewing before release. */
  draft?: true
  /** An image, or a muted looping video when it ends in .mp4 or .webm. */
  media: { src: string; alt: string }
  title: string
  body: string
  action?: { label: string; href: string }
}

export const ANNOUNCEMENT_PARAM = 'announcement'

export function currentAnnouncement(
  list: readonly Announcement[],
  seen: readonly string[],
  preview: string | null,
): Announcement | null {
  if (preview) return list.find((a) => a.id === preview) ?? null
  const latest = list.find((a) => !a.draft)
  return latest && !seen.includes(latest.id) ? latest : null
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function mediaEl({ src, alt }: Announcement['media']): HTMLElement {
  if (!/\.(mp4|webm)$/i.test(src)) {
    const img = h('img', 'ez-announce-media')
    img.src = src
    img.alt = alt
    return img
  }
  const video = h('video', 'ez-announce-media')
  video.src = src
  video.muted = true
  video.loop = true
  video.playsInline = true
  video.autoplay = !matchMedia('(prefers-reduced-motion: reduce)').matches
  video.setAttribute('aria-label', alt)
  return video
}

export function installAnnouncement(apiBase: string, list: readonly Announcement[]): HTMLElement {
  const el = h('section', 'ez-announce')
  el.hidden = true
  const preview = new URLSearchParams(location.search).get(ANNOUNCEMENT_PARAM)

  function dismiss(a: Announcement): void {
    el.hidden = true
    void fetch(`${apiBase}/announcements/seen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: a.id }),
    })
  }

  function paint(a: Announcement): void {
    el.setAttribute('aria-label', a.title)
    const close = h('button', 'ez-announce-x')
    close.type = 'button'
    close.title = '關閉'
    close.setAttribute('aria-label', '關閉')
    close.append(icon(Cancel01Icon as IconNode, 14))
    close.onclick = () => dismiss(a)
    const text = h('div', 'ez-announce-text')
    text.append(h('h2', 'ez-announce-title', a.title), h('p', 'ez-announce-body', a.body))
    if (a.action) {
      const go = h('a', 'ez-announce-go', a.action.label)
      go.href = a.action.href
      go.target = '_blank'
      go.rel = 'noopener'
      go.onclick = () => dismiss(a)
      text.append(go)
    }
    el.replaceChildren(mediaEl(a.media), text, close)
    el.hidden = false
  }

  async function seen(): Promise<string[] | null> {
    try {
      const res = await fetch(`${apiBase}/announcements/seen`)
      return res.ok ? ((await res.json()) as AnnouncementsSeenWire).seen : null
    } catch {
      return null
    }
  }

  void (async () => {
    const ids = preview ? [] : await seen()
    const a = ids && currentAnnouncement(list, ids, preview)
    if (a) paint(a)
  })()
  return el
}
