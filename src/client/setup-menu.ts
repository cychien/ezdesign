/** Everything of ezdesign that installs outside the shell, in one place: the
 *  Chrome extension and the Mac app, each a click from installed. */

import AppleIcon from '@hugeicons/core-free-icons/AppleIcon'
import ChromeIcon from '@hugeicons/core-free-icons/ChromeIcon'
import Download05Icon from '@hugeicons/core-free-icons/Download05Icon'
import CheckIcon from '@hugeicons/core-free-icons/CheckIcon'
import type { MacAppJobWire } from '../mac-app-wire.js'
import { EXTENSION_ID, EXTENSION_PING } from '../extension-id.js'
import type { SetupWire } from '../setup-wire.js'
import { host } from './host.js'
import { type IconNode, icon } from './icon.js'
import { libraryApi } from './library/api.js'
import { openInstallDialog } from './library/install.js'

export const SETUP_TEST_IDS = {
  button: 'ez-setup-button',
  menu: 'ez-setup-menu',
  extension: 'ez-setup-extension',
  macApp: 'ez-setup-mac-app',
} as const

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

interface Row {
  el: HTMLElement
  detail: HTMLElement
  action: HTMLElement
}

function row(glyph: IconNode, name: string, testId: string): Row {
  const el = h('div', 'ez-setup-row')
  el.dataset.testid = testId
  const mark = h('span', 'ez-setup-glyph')
  mark.append(icon(glyph, 18))
  const text = h('div', 'ez-setup-text')
  const detail = h('div', 'ez-setup-detail')
  text.append(h('span', 'ez-setup-name', name), detail)
  const action = h('div', 'ez-setup-action')
  el.append(mark, text, action)
  return { el, detail, action }
}

function actionButton(label: string, name: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', 'ez-setup-go', label)
  button.type = 'button'
  button.setAttribute('aria-label', `${label} ${name}`)
  button.onclick = onClick
  return button
}

function done(label: string): HTMLElement {
  const el = h('span', 'ez-setup-done')
  el.append(icon(CheckIcon as IconNode, 14), h('span', undefined, label))
  return el
}

const percent = (job: Extract<MacAppJobWire, { phase: 'downloading' }>) =>
  job.total ? Math.min(99, Math.floor((job.received / job.total) * 100)) : null

const busy = (job: MacAppJobWire) => job.phase === 'downloading' || job.phase === 'installing'

type Answer = 'present' | 'absent' | 'unknown'

const ASK_TIMEOUT_MS = 1000
/** How often an open menu asks the extension again. */
const ASK_EVERY_MS = 500

interface PageRuntime {
  lastError?: unknown
  sendMessage?(id: string, message: unknown, reply: (response: unknown) => void): void
}

/** Asks the extension itself, which knows of a removal at once; the daemon
 *  learns of one only when the browser writes it down. Chrome gives a page
 *  `chrome.runtime` only if, when it loaded, some extension let it connect:
 *  without one there is no asking, and the daemon's word stands. */
function askExtension(): Promise<Answer> {
  const runtime = (globalThis as { chrome?: { runtime?: PageRuntime } }).chrome?.runtime
  const send = runtime?.sendMessage
  if (!runtime || !send) return Promise.resolve('unknown')
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('unknown'), ASK_TIMEOUT_MS)
    try {
      send.call(runtime, EXTENSION_ID, { t: EXTENSION_PING }, (reply) => {
        clearTimeout(timer)
        resolve(runtime.lastError || !reply ? 'absent' : 'present')
      })
    } catch {
      clearTimeout(timer)
      resolve('unknown')
    }
  })
}

export interface SetupMenu {
  readonly el: HTMLElement
  /** The daemon's `setup` event. */
  update(setup: SetupWire): void
}

export function installSetupMenu(apiBase: string): SetupMenu {
  const library = libraryApi(apiBase)
  let open = false
  let setup: SetupWire | null = null
  let answer: Answer = 'unknown'
  let askTimer: ReturnType<typeof setInterval> | undefined

  const el = h('div', 'ez-setup')
  const button = h('button', 'ez-activity-btn')
  button.type = 'button'
  button.dataset.testid = SETUP_TEST_IDS.button
  button.setAttribute('aria-label', '安裝 ezdesign')
  button.title = '安裝 ezdesign'
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-expanded', 'false')
  button.append(icon(Download05Icon as IconNode, 18))

  const menu = h('div', 'ez-menu ez-setup-menu')
  menu.dataset.testid = SETUP_TEST_IDS.menu
  menu.setAttribute('role', 'dialog')
  menu.setAttribute('aria-label', '安裝 ezdesign')
  const ext = row(ChromeIcon as IconNode, 'Chrome 插件', SETUP_TEST_IDS.extension)
  const mac = row(AppleIcon as IconNode, 'Mac app', SETUP_TEST_IDS.macApp)
  menu.append(h('div', 'ez-menu-label', 'ezdesign 工具'), ext.el, mac.el)
  el.append(button, menu)

  function paintExtension(): void {
    const known = answer !== 'unknown' || !!setup
    const installed = answer === 'unknown' ? !!setup?.extension.installed : answer === 'present'
    const installedIn = installed ? (setup?.extension.installedIn ?? []) : []
    ext.detail.textContent = installedIn.length ? `已裝在 ${installedIn.join('、')}` : '把任何網頁上的畫面存進素材庫'
    if (!known) return ext.action.replaceChildren()
    ext.action.replaceChildren(
      installed
        ? done('已安裝')
        : actionButton('安裝', 'Chrome 插件', () => {
            setOpen(false)
            openInstallDialog(library)
          }),
    )
  }

  const progressBar = h('span', 'ez-setup-progress')
  const progressLabel = h('span', 'ez-setup-progress-label')

  function paintMacApp(): void {
    const macApp = setup?.macApp
    mac.el.hidden = !macApp?.supported
    if (!macApp?.supported) return
    const { job, installed } = macApp
    button.toggleAttribute('data-working', busy(job))
    mac.detail.removeAttribute('title')
    delete mac.detail.dataset.tone

    if (host.kind === 'desktop') {
      mac.detail.textContent = '你正在用它'
      mac.action.replaceChildren(done('使用中'))
    } else if (job.phase === 'downloading') {
      const pct = percent(job)
      progressBar.style.setProperty('--progress', `${pct ?? 0}%`)
      progressBar.toggleAttribute('data-indeterminate', pct === null)
      progressLabel.textContent = pct === null ? '下載中…' : `下載中 ${pct}%`
      // Kept in place between updates, so the bar's width eases instead of jumping.
      if (progressBar.parentElement !== mac.detail) mac.detail.replaceChildren(progressBar, progressLabel)
      mac.action.replaceChildren()
    } else if (job.phase === 'installing') {
      mac.detail.textContent = '安裝中…'
      mac.action.replaceChildren()
    } else if (installed) {
      mac.detail.textContent = `已安裝 ${installed.version}`
      mac.action.replaceChildren(actionButton('打開', 'Mac app', () => void fetch(`${apiBase}/mac-app/open`, { method: 'POST' })))
    } else if (job.phase === 'failed') {
      mac.detail.dataset.tone = 'error'
      mac.detail.title = job.error
      const manual = h('a', 'ez-setup-link', '改用手動下載')
      manual.href = macApp.releasesUrl
      manual.target = '_blank'
      manual.rel = 'noopener'
      const reason = h('span', undefined, '沒裝起來，')
      reason.append(manual)
      mac.detail.replaceChildren(reason)
      mac.action.replaceChildren(actionButton('再試一次', 'Mac app', startMacInstall))
    } else {
      mac.detail.textContent = '獨立視窗，不用開終端機'
      mac.action.replaceChildren(actionButton('安裝', 'Mac app', startMacInstall))
    }
  }

  function startMacInstall(): void {
    void fetch(`${apiBase}/mac-app/install`, { method: 'POST' })
  }

  async function ask(): Promise<void> {
    const next = await askExtension()
    if (next === answer) return
    answer = next
    paintExtension()
  }

  function setOpen(next: boolean): void {
    open = next
    el.toggleAttribute('data-open', open)
    button.setAttribute('aria-expanded', String(open))
    clearInterval(askTimer)
    if (open) {
      void ask()
      askTimer = setInterval(() => void ask(), ASK_EVERY_MS)
    }
  }

  button.onclick = () => setOpen(!open)
  document.addEventListener('click', (e) => {
    if (open && e.target instanceof Node && !el.contains(e.target)) setOpen(false)
  })
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      setOpen(false)
      button.focus()
    }
  })
  // Back from chrome://extensions, which is where an extension is removed.
  window.addEventListener('focus', () => void ask())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void ask()
  })

  paintExtension()
  void ask()
  return {
    el,
    update(next) {
      setup = next
      paintExtension()
      paintMacApp()
      void ask()
    },
  }
}
