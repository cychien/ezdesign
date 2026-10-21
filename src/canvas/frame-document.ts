/** A frame file as the iframe receives it, and where it is received from.
 *
 *  Origin model. Frames are served by the session's own listener under another
 *  host: `http://localhost:<port>`, while the shell, the api and the proxied app
 *  stay on `http://127.0.0.1:<port>`. A different host is a different origin and
 *  a different *site*, so an agent-written document and the CDN scripts it loads
 *  cannot read the shell's storage, script the shell, or act on the api
 *  (`refuseCrossSite`), and Chrome runs them in their own renderer process, off
 *  the shell's main thread. The frame keeps its own origin
 *  (`sandbox="allow-same-origin ..."`), so `localStorage` and CDN libraries that
 *  touch it work.
 *
 *  Two things happen to the bytes on the way out, in this order:
 *
 *  1. Every element start tag gets `data-ez-source="<file>:<line>"`, the
 *     attribute the Vite plugin stamps on app elements, so the overlay's
 *     `buildAnchor` resolves an element inside a frame to the frame file's
 *     `file:line` with no canvas code of its own. Lines are of the file as
 *     stored, which is the file the agent opens.
 *  2. The overlay is injected in its `relay` configuration (`overlay-link.ts`),
 *     with absolute asset urls on the shell's origin: the frame host serves
 *     frame documents and nothing else. */

import { URL_PREFIX } from '../constants.js'
import type { FrameRef } from '../protocol.js'
import { type CanvasId, type CanvasProblem, type FrameId, MAX_FRAME_HTML } from './types.js'

/** The frame host. Chrome resolves `localhost` to loopback without DNS. */
export const FRAME_HOST = 'localhost'
/** Under `URL_PREFIX`, on the frame host only. */
export const FRAME_ROUTE = '/frames'

/** `http://localhost:<port>/__ezdesign/frames/<canvasId>/<frameId>?rev=<hash>`.
 *  The revision in the url is what lets the document be cached `immutable` and
 *  what makes a changed hash a reload. */
export function frameUrl(frameOrigin: string, canvasId: CanvasId, frameId: FrameId, hash: string): string {
  return `${frameOrigin}${URL_PREFIX}${FRAME_ROUTE}/${canvasId}/${frameId}?rev=${hash}`
}

/** Whether a `Host` header names the frame host. Shared by the request switch
 *  and the upgrade handler, so the two cannot disagree. */
export function isFrameHost(host: string | undefined): boolean {
  if (!host) return false
  return host.replace(/:\d+$/, '').toLowerCase() === FRAME_HOST
}

/** How the overlay inside a frame is configured. Written onto its script tag
 *  as data attributes and read once at boot by `linkFromScript`. */
export interface FrameOverlayConfig {
  /** Daemon version, in the asset urls, so forty frames fetch the overlay once. */
  version: string
  /** `http://127.0.0.1:<port>`: the only window the relay posts to. */
  shellOrigin: string
  /** Informational: the shell attributes anchors from the window a message came
   *  from, never from this. */
  place: FrameRef
}

export function renderFrameDocument(input: {
  html: string
  /** Project-relative path, what goes before `:line`. */
  file: string
  overlay: FrameOverlayConfig
}): string {
  return injectFrameOverlay(stampSourceLines(input.html, input.file), input.overlay)
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'iframe', 'xmp'])
const UNSTAMPED = new Set(['html', 'head'])

const escapeAttr = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A scanner, not a parser: one forward pass with a line counter over text |
 *  tag | quoted attribute | comment | raw text. Skips comments, the doctype and
 *  the raw-text bodies of script, style, textarea, title, noscript, iframe;
 *  leaves a tag that already has `data-ez-source` alone; stamps nothing on
 *  `html`, `head` or inside `head`. Elements a script creates later carry no
 *  stamp, so `closest('[data-ez-source]')` lands on the written ancestor. */
export function stampSourceLines(html: string, file: string): string {
  const lower = html.toLowerCase()
  const out: string[] = []
  let line = 1
  let copied = 0
  let inHead = false
  const advance = (to: number) => {
    for (let k = copied; k < to; k++) if (html.charCodeAt(k) === 10) line++
    out.push(html.slice(copied, to))
    copied = to
  }
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt)
      i = end < 0 ? html.length : end + 1
      continue
    }
    const closing = html[lt + 1] === '/'
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(lt + (closing ? 2 : 1), lt + 64))
    if (!nameMatch) {
      i = lt + 1
      continue
    }
    const name = nameMatch[0].toLowerCase()
    const nameEnd = lt + (closing ? 2 : 1) + nameMatch[0].length
    let end = nameEnd
    let quote: string | null = null
    for (; end < html.length; end++) {
      const c = html[end]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
    }
    if (closing) {
      if (name === 'head') inHead = false
      i = end + 1
      continue
    }
    const tag = html.slice(lt, end)
    if (!inHead && !UNSTAMPED.has(name) && !/\sdata-ez-source\s*=/i.test(tag)) {
      advance(nameEnd)
      out.push(` data-ez-source="${escapeAttr(`${file}:${line}`)}"`)
    }
    if (name === 'head') inHead = true
    i = end + 1
    if (RAW_TEXT.has(name) && !tag.endsWith('/')) {
      const close = lower.indexOf(`</${name}`, i)
      i = close < 0 ? html.length : close
    }
  }
  advance(html.length)
  return out.join('')
}

const FRAME_OVERLAY_MARK = 'data-ez-link="relay"'

/** After `<head ...>` (else `<body ...>`, else `<html ...>`, else the doctype,
 *  else first), idempotently. `injectOverlay` (proxied App HTML) writes no
 *  `data-ez-link`, which is what keeps an App overlay `direct`: a page cannot
 *  switch it, because the attribute is read from the daemon's own tag. */
export function injectFrameOverlay(html: string, config: FrameOverlayConfig): string {
  if (html.includes(FRAME_OVERLAY_MARK)) return html
  const shell = escapeAttr(config.shellOrigin)
  const v = encodeURIComponent(config.version)
  const snippet =
    `<link rel="stylesheet" href="${shell}${URL_PREFIX}/overlay.css?v=${v}">` +
    `<script defer src="${shell}${URL_PREFIX}/overlay.js?v=${v}" ${FRAME_OVERLAY_MARK} data-ez-shell="${shell}"></script>`
  for (const pattern of [/<head(\s[^>]*)?>/i, /<body(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = pattern.exec(html)
    if (m) {
      const at = m.index + m[0].length
      return html.slice(0, at) + snippet + html.slice(at)
    }
  }
  return snippet + html
}

/** Null when `html` may be a frame. The daemon has no DOM, so this is the part
 *  that needs none; scripts and CDN assets are allowed. */
export function checkFrameHtml(html: string): CanvasProblem | null {
  if (!html.trim()) return { code: 'HTML_EMPTY' }
  const bytes = Buffer.byteLength(html)
  if (bytes > MAX_FRAME_HTML) return { code: 'HTML_TOO_LARGE', bytes, limit: MAX_FRAME_HTML }
  const head = html.replace(/^(\s|<!--[\s\S]*?-->)*/, '')
  return /^<!doctype\s+html[\s>]/i.test(head) || /^<html[\s>]/i.test(head)
    ? null
    : { code: 'NOT_A_DOCUMENT' }
}
