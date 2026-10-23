/** The capture library, browsed from the shell: everything the Chrome extension
 *  saved or the user pasted, across projects, searched by note and page title
 *  and filtered by tag.
 *  It covers the whole workspace while it shows, the way the sketch has it: a
 *  grid of references wants the width, and the review is one click away. */

import type { LibraryItemWire } from '../../library-wire.js'
import { encodeThumbnail } from '../thumbnail.js'
import { libraryBrowser } from './browse.js'
import { openDetail } from './detail.js'
import { openInstallDialog } from './install.js'
import { LIBRARY_TEST_IDS as IDS } from './names.js'
import { libraryApi } from './api.js'

export interface LibraryView {
  readonly el: HTMLElement
  /** Shows the newest saves; called whenever the view comes into sight. */
  refresh(): void
}

const TOAST_MS = 1800

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

export function installLibrary(apiBase: string): LibraryView {
  const api = libraryApi(apiBase)

  const el = h('section', 'ez-library')
  el.setAttribute('aria-label', '素材庫')
  el.dataset.testid = IDS.view
  const scroll = h('div', 'ez-library-scroll')
  const head = h('header', 'ez-library-head')
  const title = h('h1', 'ez-library-title', '素材庫')

  const browser = libraryBrowser(api, {
    scroll,
    decorate: (button, _item, index) => {
      button.onclick = () => showDetail(index)
    },
    blank: () => {
      const install = h('button', 'ez-library-empty-link', '安裝 ezdesign 插件')
      install.type = 'button'
      install.dataset.testid = IDS.install
      install.onclick = () => openInstallDialog(api)
      return [
        h('p', 'ez-library-empty-title', '還沒有任何素材'),
        h('p', 'ez-library-empty-body', '使用 ezdesign 插件擷取頁面，或直接貼上素材'),
        install,
      ]
    },
  })
  head.append(title, browser.searchBox, browser.tagRow)
  scroll.append(head, browser.grid, browser.empty, browser.sentinel)
  const toast = h('p', 'ez-library-toast')
  toast.setAttribute('role', 'status')
  toast.dataset.testid = IDS.toast
  toast.hidden = true
  el.append(scroll, toast)

  let toastTimer: ReturnType<typeof setTimeout> | undefined
  function say(text: string, tone: 'ok' | 'error' | 'busy'): void {
    clearTimeout(toastTimer)
    toast.textContent = text
    toast.dataset.tone = tone
    toast.hidden = false
    if (tone !== 'busy') toastTimer = setTimeout(() => (toast.hidden = true), TOAST_MS)
  }

  async function addPasted(files: File[]): Promise<void> {
    say(files.length > 1 ? `正在加入 ${files.length} 張圖片…` : '正在加入…', 'busy')
    let added = 0
    let known = 0
    for (const file of files) {
      try {
        const { thumbnail, size } = await thumbnailOf(file)
        const result = await api.paste(file, new Blob([thumbnail.webp], { type: 'image/webp' }), {
          thumbnail: { width: thumbnail.width, height: thumbnail.height },
          source: size,
        })
        if (result.merged) known++
        else added++
      } catch (error) {
        say(`沒加進去：${error instanceof Error ? error.message : String(error)}`, 'error')
        // A paste lands at the head of an unfiltered grid, where it can be seen.
        if (added + known) browser.showNewest()
        return
      }
    }
    say(added ? '已加入素材庫' : '素材庫裡已經有這張了', 'ok')
    browser.showNewest()
  }

  document.addEventListener('paste', (e) => {
    if (el.hidden || document.querySelector('dialog[open]')) return
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    void addPasted(files)
  })

  function showDetail(index: number): void {
    openDetail({
      api,
      items: browser.items,
      index,
      knownTags: browser.tags,
      onChange: (item: LibraryItemWire) => {
        browser.replace(item)
        void browser.loadTags()
      },
      onRemove: (id) => {
        browser.remove(id)
        void browser.loadTags()
      },
      returnFocus: (id) => browser.grid.querySelector<HTMLElement>(`[data-item-id="${id}"]`),
    })
  }

  return { el, refresh: browser.show }
}

/** SVG has no bitmap decode; an `<img>` takes it, and anything else the browser shows. */
async function thumbnailOf(file: File) {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (bitmap) {
    const size = { width: bitmap.width, height: bitmap.height }
    return { thumbnail: await encodeThumbnail(bitmap, size), size }
  }
  const img = new Image()
  img.src = URL.createObjectURL(file)
  try {
    await img.decode().catch(() => {
      throw new Error('這個檔案打不開')
    })
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('這張圖片沒有尺寸')
    const size = { width: img.naturalWidth, height: img.naturalHeight }
    return { thumbnail: await encodeThumbnail(img, size), size }
  } finally {
    URL.revokeObjectURL(img.src)
  }
}
