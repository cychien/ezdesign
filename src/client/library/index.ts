/** The capture library, browsed from the shell: everything the Chrome extension
 *  saved, across projects, searched by note and page title and filtered by tag.
 *  It covers the whole workspace while it shows, the way the sketch has it: a
 *  grid of references wants the width, and the review is one click away. */

import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import PlayIcon from '@hugeicons/core-free-icons/PlayIcon'
import Link01Icon from '@hugeicons/core-free-icons/Link01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import type { LibraryItemWire, LibraryPageWire, LibraryTagWire } from '../../library-wire.js'
import { type IconNode, icon } from '../icon.js'
import { openDetail } from './detail.js'
import { LIBRARY_TEST_IDS as IDS } from './names.js'
import { libraryApi } from './api.js'
import { hostOf } from './format.js'

export interface LibraryView {
  readonly el: HTMLElement
  /** Shows the newest saves; called whenever the view comes into sight. */
  refresh(): void
}

const SEARCH_DEBOUNCE_MS = 200

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

  const searchBox = h('label', 'ez-library-search')
  const search = h('input')
  search.type = 'search'
  search.placeholder = '搜尋筆記或頁面標題'
  search.setAttribute('aria-label', '搜尋素材')
  search.dataset.testid = IDS.search
  search.autocomplete = 'off'
  search.spellcheck = false
  const clearSearch = h('button', 'ez-library-search-clear')
  clearSearch.type = 'button'
  clearSearch.setAttribute('aria-label', '清除搜尋')
  clearSearch.hidden = true
  clearSearch.append(icon(Cancel01Icon as IconNode, 14))
  searchBox.append(icon(Search01Icon as IconNode, 16), search, clearSearch)

  const tagRow = h('div', 'ez-library-tags')
  tagRow.setAttribute('role', 'group')
  tagRow.setAttribute('aria-label', '依標籤篩選')
  tagRow.dataset.testid = IDS.tags
  head.append(title, searchBox, tagRow)

  const grid = h('ul', 'ez-library-grid')
  grid.dataset.testid = IDS.grid
  const empty = h('div', 'ez-library-empty')
  empty.hidden = true
  const sentinel = h('div', 'ez-library-sentinel')
  scroll.append(head, grid, empty, sentinel)
  el.append(scroll)

  let items: LibraryItemWire[] = []
  let tags: LibraryTagWire[] = []
  const chosen = new Set<string>()
  let next: string | null = null
  let loading = false
  /** Bumped by every query change, so a slow answer to an old one is dropped. */
  let generation = 0
  let failed: string | null = null

  const query = () => ({ q: search.value.trim(), tags: [...chosen] })
  const filtered = () => query().q !== '' || chosen.size > 0

  function paintTags(): void {
    // A chosen tag stays on the row even once nothing carries it any more, or
    // there would be no way to take it off.
    const shown = [...tags]
    for (const name of chosen) if (!shown.some((t) => t.name === name)) shown.push({ name, uses: 0 })
    tagRow.hidden = shown.length === 0
    const all = h('button', 'ez-library-tag')
    all.type = 'button'
    all.textContent = '全部'
    all.setAttribute('aria-pressed', String(chosen.size === 0))
    all.onclick = () => {
      if (!chosen.size) return
      chosen.clear()
      reload()
    }
    tagRow.replaceChildren(
      all,
      ...shown.map((tag) => {
        const chip = h('button', 'ez-library-tag')
        chip.type = 'button'
        chip.setAttribute('aria-pressed', String(chosen.has(tag.name)))
        chip.append(h('span', undefined, tag.name))
        if (tag.uses) chip.append(h('span', 'ez-library-tag-uses', String(tag.uses)))
        chip.onclick = () => {
          if (chosen.has(tag.name)) chosen.delete(tag.name)
          else chosen.add(tag.name)
          reload()
        }
        return chip
      }),
    )
  }

  function card(item: LibraryItemWire, index: number): HTMLLIElement {
    const li = h('li')
    const button = h('button', 'ez-library-card')
    button.type = 'button'
    button.dataset.testid = IDS.card
    button.dataset.itemId = item.id
    button.setAttribute('aria-label', cardLabel(item))
    const media = h('span', 'ez-library-card-media')
    if (item.thumbnail) {
      const img = h('img')
      img.src = item.thumbnail.url
      img.alt = ''
      img.loading = 'lazy'
      img.decoding = 'async'
      const frame = h('span', 'ez-library-card-frame')
      frame.append(img)
      media.append(frame)
    }
    if (item.kind === 'video') {
      const badge = h('span', 'ez-library-card-badge')
      badge.append(icon((item.link ? Link01Icon : PlayIcon) as IconNode, 12))
      badge.append(h('span', undefined, item.link ? '連結' : '影片'))
      media.append(badge)
    }
    const caption = h('span', 'ez-library-card-caption', item.source.pageTitle || hostOf(item.source.pageUrl))
    button.append(media, caption)
    button.onclick = () => showDetail(index)
    li.append(button)
    return li
  }

  function paintGrid(): void {
    grid.replaceChildren(...items.map(card))
    paintEmpty()
  }

  function paintEmpty(): void {
    empty.replaceChildren()
    empty.hidden = items.length > 0 || loading
    if (empty.hidden) return
    if (failed) {
      empty.append(h('p', 'ez-library-empty-title', '打不開素材庫'), h('p', 'ez-library-empty-body', failed))
      return
    }
    if (filtered()) {
      const reset = h('button', 'ez-library-empty-action', '清除篩選')
      reset.type = 'button'
      reset.onclick = () => {
        search.value = ''
        chosen.clear()
        reload()
      }
      empty.append(h('p', 'ez-library-empty-title', '沒有符合的素材'), reset)
      return
    }
    const how = h('p', 'ez-library-empty-body')
    how.append(
      '在 Chrome 對圖片或影片按右鍵，選「儲存至 ezdesign」；或按 ',
      h('kbd', undefined, 'Alt+Shift+S'),
      ' 框選畫面。',
    )
    const install = h('p', 'ez-library-empty-body')
    install.append('還沒裝擴充功能？在終端機執行 ', h('code', undefined, 'ezdesign extension install'))
    empty.append(h('p', 'ez-library-empty-title', '還沒有收藏任何素材'), how, install)
  }

  async function load(reset: boolean): Promise<void> {
    if (loading && !reset) return
    const mine = reset ? ++generation : generation
    loading = true
    try {
      const page: LibraryPageWire = await api.items({ ...query(), before: reset ? null : next })
      if (mine !== generation) return
      failed = null
      items = reset ? page.items : [...items, ...page.items]
      next = page.next
      if (reset) {
        paintGrid()
        scroll.scrollTop = 0
      } else {
        const from = grid.children.length
        grid.append(...page.items.map((item, i) => card(item, from + i)))
      }
    } catch (error) {
      if (mine !== generation) return
      failed = error instanceof Error ? error.message : String(error)
      if (reset) items = []
      paintGrid()
    } finally {
      if (mine === generation) {
        loading = false
        paintEmpty()
        // Re-observed so the sentinel is judged afresh: one still in view after a
        // short page would otherwise never fire again.
        more.unobserve(sentinel)
        if (next) more.observe(sentinel)
      }
    }
  }

  async function loadTags(): Promise<void> {
    try {
      tags = await api.tags()
    } catch {
      // The grid reports why the library is unreachable; the row just stays as it was.
    }
    paintTags()
  }

  function reload(): void {
    clearSearch.hidden = search.value === ''
    next = null
    more.disconnect()
    paintTags()
    void load(true)
  }

  /** Puts saves made since the grid was loaded at its head, without moving the
   *  user from where they have scrolled to. */
  async function refresh(): Promise<void> {
    void loadTags()
    if (!items.length || filtered() || failed) return reload()
    const mine = generation
    try {
      const page = await api.items({ ...query(), before: null })
      if (mine !== generation) return
      const known = new Set(items.map((i) => i.id))
      const fresh = page.items.filter((i) => !known.has(i.id) && i.id > items[0]!.id)
      if (!fresh.length) return
      items = [...fresh, ...items]
      paintGrid()
    } catch {
      // A failed refresh leaves what is already on screen.
    }
  }

  const more = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && next && !loading) void load(false)
    },
    { root: scroll, rootMargin: '600px 0px' },
  )

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  search.addEventListener('input', () => {
    clearSearch.hidden = search.value === ''
    clearTimeout(searchTimer)
    searchTimer = setTimeout(reload, SEARCH_DEBOUNCE_MS)
  })
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault()
      e.stopPropagation()
      search.value = ''
      reload()
    }
  })
  clearSearch.onclick = (e) => {
    e.preventDefault()
    search.value = ''
    reload()
    search.focus()
  }

  function showDetail(index: number): void {
    openDetail({
      api,
      items: () => items,
      index,
      knownTags: () => tags,
      onChange: (item) => {
        const at = items.findIndex((i) => i.id === item.id)
        if (at < 0) return
        items[at] = item
        const old = grid.children[at]
        old?.replaceWith(card(item, at))
        void loadTags()
      },
      onRemove: (id) => {
        items = items.filter((i) => i.id !== id)
        paintGrid()
        void loadTags()
      },
      returnFocus: (id) => grid.querySelector<HTMLElement>(`[data-item-id="${id}"]`),
    })
  }

  return {
    el,
    refresh: () => {
      if (items.length === 0 && !loading && generation === 0) {
        void loadTags()
        void load(true)
      } else void refresh()
    },
  }
}

function cardLabel(item: LibraryItemWire): string {
  const parts = [item.source.pageTitle || hostOf(item.source.pageUrl)]
  if (item.tags.length) parts.push(item.tags.join('、'))
  if (item.note) parts.push(item.note)
  return parts.join('，')
}
