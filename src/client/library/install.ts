/** Sets the capture extension up from the shell. The daemon installs the native
 *  host and the extension folder; the user loads that folder once, by hand,
 *  since Chrome takes an extension from outside its store no other way. The
 *  dialog then waits for the host to greet the extension, which is the proof
 *  that saving works. */

import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import { type IconNode, icon } from '../icon.js'
import type { CaptureInstallProblem, ExtensionInstallErrorWire } from '../../capture-setup-wire.js'
import type { LibraryApi } from './api.js'
import { LIBRARY_TEST_IDS as IDS } from './names.js'

const POLL_MS = 1000
const COPIED_MS = 1500
const EXTENSIONS_PAGE = 'chrome://extensions'

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function copyField(value: string, label: string): HTMLElement {
  const row = h('div', 'ez-install-copy')
  const code = h('code', undefined, value)
  const button = h('button', 'ez-install-copy-button')
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.title = label
  button.append(icon(Copy01Icon as IconNode, 14))
  let timer: ReturnType<typeof setTimeout> | undefined
  button.onclick = () => {
    void navigator.clipboard.writeText(value).then(() => {
      clearTimeout(timer)
      button.replaceChildren(icon(Tick02Icon as IconNode, 14))
      timer = setTimeout(() => button.replaceChildren(icon(Copy01Icon as IconNode, 14)), COPIED_MS)
    })
  }
  row.append(code, button)
  return row
}

const PROBLEMS: Partial<Record<CaptureInstallProblem, string>> = {
  'no-browser': '這台電腦上找不到 Chrome，或其他以 Chromium 為基礎的瀏覽器',
  'unsupported-platform': '目前只支援 macOS 和 Linux',
  'node-too-old': '存素材需要 Node 22.13 以上，請先更新 Node',
}

function problemText(error: unknown): string {
  const problem = ((error as Error | null)?.cause as ExtensionInstallErrorWire | null)?.problem
  return (problem && PROBLEMS[problem]) ?? `沒裝起來：${error instanceof Error ? error.message : String(error)}`
}

function step(...content: (Node | string)[]): HTMLLIElement {
  const li = h('li', 'ez-install-step')
  li.append(...content)
  return li
}

export function openInstallDialog(api: LibraryApi): void {
  const dialog = h('dialog', 'ez-dialog ez-install')
  dialog.dataset.testid = IDS.installDialog
  const title = h('h2', 'ez-dialog-title', '安裝 ezdesign 插件')
  title.id = 'ez-install-title'
  dialog.setAttribute('aria-labelledby', title.id)
  const body = h('div', 'ez-install-body')
  const status = h('p', 'ez-install-status')
  status.setAttribute('role', 'status')
  const close = h('button', 'ez-dialog-cancel', '關閉')
  close.type = 'button'
  const actions = h('div', 'ez-dialog-actions')
  actions.append(status, close)
  const card = h('div', 'ez-dialog-card')
  card.append(title, body, actions)
  dialog.append(card)
  document.body.append(dialog)

  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  /** A greeting from before the install may be from an extension since removed. */
  let since = 0

  function finish(): void {
    if (closed) return
    closed = true
    clearTimeout(timer)
    dialog.close()
    dialog.remove()
  }

  function showConnected(): void {
    clearTimeout(timer)
    body.replaceChildren(h('p', 'ez-dialog-body', '裝好了。之後在網頁上看到喜歡的畫面，就能存進素材庫。'))
    status.replaceChildren(icon(Tick02Icon as IconNode, 14), h('span', undefined, '已連線'))
    status.dataset.tone = 'ok'
    close.className = 'ez-dialog-go'
    close.textContent = '完成'
    close.focus()
  }

  async function poll(): Promise<void> {
    if (closed) return
    const { greeted } = await api.extensionStatus().catch(() => ({ greeted: null }))
    if (closed) return
    if (greeted && greeted.at >= since) showConnected()
    else timer = setTimeout(() => void poll(), POLL_MS)
  }

  async function install(): Promise<void> {
    body.replaceChildren(h('p', 'ez-dialog-body', '正在準備…'))
    status.replaceChildren()
    delete status.dataset.tone
    since = Date.now()
    try {
      const { extensionDir } = await api.installExtension()
      if (closed) return
      const mac = /Mac/.test(navigator.platform)
      const steps = h('ol', 'ez-install-steps')
      steps.append(
        step(h('span', undefined, '在 Chrome 開啟擴充功能頁面'), copyField(EXTENSIONS_PAGE, '複製網址')),
        step(h('span', undefined, '打開右上角的「開發人員模式」')),
        step(
          h('span', undefined, '按「載入未封裝項目」，選擇這個資料夾'),
          copyField(extensionDir, '複製路徑'),
          h('span', 'ez-install-hint', `在選擇資料夾的視窗按 ${mac ? '⌘⇧G' : 'Ctrl+L'} 就能貼上路徑`),
        ),
      )
      body.replaceChildren(steps)
      status.replaceChildren(h('span', 'ez-install-waiting'), h('span', undefined, '等待插件連線'))
      void poll()
    } catch (error) {
      if (closed) return
      const retry = h('button', 'ez-library-empty-action', '再試一次')
      retry.type = 'button'
      retry.onclick = () => void install()
      body.replaceChildren(
        h('p', 'ez-dialog-body', problemText(error)),
        retry,
      )
    }
  }

  close.onclick = finish
  // Only the backdrop is the dialog itself: the card covers all of its box.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) finish()
  })
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault()
    finish()
  })
  // The shell's keys must not act behind it.
  dialog.addEventListener('keydown', (e) => e.stopPropagation())
  dialog.showModal()
  close.focus()
  void install()
}
