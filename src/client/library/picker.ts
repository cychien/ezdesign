/** The composer's `/library`: the library in a modal, browsed the same way the
 *  panel browses it, where cards toggle instead of opening. What the user
 *  settles on is copied into the session's attachments, so every composer -
 *  the shell's own and an overlay's that asked the shell - chips it as a file. */

import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import type { LibraryAttachedWire } from '../../library-wire.js'
import { type IconNode, icon } from '../icon.js'
import { type LibraryApi, libraryApi } from './api.js'
import { libraryBrowser } from './browse.js'
import { LIBRARY_TEST_IDS as IDS } from './names.js'

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/** Empty when the user called it off. Rejects only when the copy fails. */
export async function chooseLibraryAttachments(apiBase: string): Promise<LibraryAttachedWire[]> {
  const api = libraryApi(apiBase)
  const ids = await pickFromLibrary(api)
  return ids.length ? api.attach(ids) : []
}

/** Item ids in the order they were chosen, which is the order they will sit in
 *  the sentence. */
export function pickFromLibrary(api: LibraryApi): Promise<string[]> {
  const dialog = h('dialog', 'ez-library-picker')
  dialog.dataset.testid = IDS.picker
  const title = h('h2', 'ez-library-picker-title', '選擇素材')
  title.id = 'ez-library-picker-title'
  dialog.setAttribute('aria-labelledby', title.id)
  const close = h('button', 'ez-library-detail-close')
  close.type = 'button'
  close.setAttribute('aria-label', '關閉（Esc）')
  close.title = '關閉（Esc）'
  close.append(icon(Cancel01Icon as IconNode, 16))
  const top = h('div', 'ez-library-picker-top')
  top.append(title, close)

  const scroll = h('div', 'ez-library-scroll')
  const head = h('div', 'ez-library-head')
  const chosen: string[] = []

  const browser = libraryBrowser(api, {
    scroll,
    decorate: (button, item) => {
      const check = h('span', 'ez-library-card-check')
      check.append(icon(Tick02Icon as IconNode, 12))
      button.querySelector('.ez-library-card-media')!.append(check)
      button.setAttribute('aria-pressed', String(chosen.includes(item.id)))
      button.onclick = () => {
        const at = chosen.indexOf(item.id)
        if (at < 0) chosen.push(item.id)
        else chosen.splice(at, 1)
        button.setAttribute('aria-pressed', String(at < 0))
        paintCount()
      }
    },
    blank: () => [
      h('p', 'ez-library-empty-title', '還沒有任何素材'),
      h('p', 'ez-library-empty-body', '使用 ezdesign 插件擷取頁面，或在素材庫貼上圖片'),
    ],
  })
  head.append(browser.searchBox, browser.tagRow)
  scroll.append(head, browser.grid, browser.empty, browser.sentinel)

  const count = h('p', 'ez-library-picker-count')
  count.setAttribute('role', 'status')
  const cancel = h('button', 'ez-dialog-cancel', '取消')
  cancel.type = 'button'
  const confirm = h('button', 'ez-dialog-go')
  confirm.type = 'button'
  confirm.dataset.testid = IDS.pickerConfirm
  const foot = h('div', 'ez-library-picker-foot')
  foot.append(count, cancel, confirm)

  dialog.append(top, scroll, foot)
  document.body.append(dialog)

  function paintCount(): void {
    count.textContent = chosen.length ? `已選 ${chosen.length} 個` : '點選素材加入，可多選'
    confirm.textContent = chosen.length ? `加入 ${chosen.length} 個` : '加入'
    confirm.disabled = chosen.length === 0
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (ids: string[]) => {
      if (settled) return
      settled = true
      dialog.close()
      dialog.remove()
      resolve(ids)
    }
    close.onclick = () => finish([])
    cancel.onclick = () => finish([])
    confirm.onclick = () => finish([...chosen])
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      finish([])
    })
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) finish([])
    })
    dialog.addEventListener('keydown', (e) => {
      // The review behind is inert, but the shell's shortcuts listen on the
      // document, and ⌘+Enter there sends the batch.
      e.stopPropagation()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && chosen.length) {
        e.preventDefault()
        finish([...chosen])
      }
    })
    paintCount()
    dialog.showModal()
    browser.search.focus()
    browser.show()
  })
}
