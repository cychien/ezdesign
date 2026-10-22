import type { CaptureId, PageCommand, PreviewHandoff } from '../shared/messages.js'
import { lastInspected } from './locate.js'

const mounted = new Map<CaptureId, HTMLElement>()

const FRAME_STYLE = [
  'position: fixed',
  'inset: 0',
  'width: 100vw',
  'height: 100vh',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'background: transparent',
  'color-scheme: light',
  'z-index: 2147483647',
].join('; ')

export async function presentDialog(
  command: Extract<PageCommand, { type: 'present' }>,
): Promise<{ mounted: boolean; handedOff: boolean }> {
  const host = document.createElement('div')
  host.setAttribute('data-ez-capture', '')
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647'
  const root = host.attachShadow({ mode: 'closed' })
  const frame = document.createElement('iframe')
  frame.setAttribute('style', FRAME_STYLE)
  frame.setAttribute('allow', 'clipboard-write')
  frame.src = chrome.runtime.getURL(command.dialogPath)
  root.append(frame)
  const loaded = new Promise<boolean>((resolve) => {
    frame.addEventListener('load', () => resolve(true), { once: true })
    frame.addEventListener('error', () => resolve(false), { once: true })
  })
  document.documentElement.append(host)
  mounted.set(command.captureId, host)
  if (!(await loaded) || !frame.contentWindow) {
    dismissDialog(command.captureId)
    return { mounted: false, handedOff: false }
  }
  frame.focus()
  const element = command.bitmap ? lastInspected() : null
  const bitmap = element && (await createImageBitmap(element).catch(() => null))
  if (!bitmap) return { mounted: true, handedOff: false }
  try {
    const handoff: PreviewHandoff = { type: 'ez-capture-preview', nonce: command.nonce, bitmap }
    // `*`: with use_dynamic_url the frame's origin is not the one `getURL` names.
    frame.contentWindow.postMessage(handoff, '*', [bitmap])
    return { mounted: true, handedOff: true }
  } catch {
    bitmap.close()
    return { mounted: true, handedOff: false }
  }
}

export function dismissDialog(captureId: CaptureId): void {
  mounted.get(captureId)?.remove()
  mounted.delete(captureId)
}
