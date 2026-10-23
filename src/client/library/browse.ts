/** Finding things in the library: a search box, a row of tag toggles and a
 *  paged grid of cards. The library panel and the composer's picker both browse
 *  this way and differ only in what a card does, so that is the one thing a
 *  host hands in. */

import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import PlayIcon from '@hugeicons/core-free-icons/PlayIcon'
import Link01Icon from '@hugeicons/core-free-icons/Link01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import type { LibraryItemWire, LibraryPageWire, LibraryTagWire } from '../../library-wire.js'
import { type IconNode, icon } from '../icon.js'
import type { LibraryApi } from './api.js'
import { sourceName } from './format.js'
import { LIBRARY_TEST_IDS as IDS } from './names.js'

export interface BrowserOptions {
  /** The scrolling box the grid sits in, which decides when the next page loads. */
  scroll: HTMLElement
  /** Gives a card its behaviour. Called for every card, every time it is drawn. */
  decorate(button: HTMLButtonElement, item: LibraryItemWire, index: number): void
  /** What an empty, unfiltered library says. */
  blank(): Node[]
}

export interface LibraryBrowser {
  readonly searchBox: HTMLElement
  readonly search: HTMLInputElement
  readonly tagRow: HTMLElement
  readonly grid: HTMLUListElement
  readonly empty: HTMLElement
  readonly sentinel: HTMLElement
  items(): readonly LibraryItemWire[]
  tags(): readonly LibraryTagWire[]
  /** The first page on first call; afterwards, saves made since put at the head. */
  show(): void
  /** Filters off and the newest first, for something just added. */
  showNewest(): void
  loadTags(): Promise<void>
  replace(item: LibraryItemWire): void
  remove(id: string): void
}

const SEARCH_DEBOUNCE_MS = 200

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

export function libraryBrowser(api: LibraryApi, { scroll, decorate, blank }: BrowserOptions): LibraryBrowser {
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

  const grid = h('ul', 'ez-library-grid')
  grid.dataset.testid = IDS.grid
  const empty = h('div', 'ez-library-empty')
  empty.hidden = true
  const sentinel = h('div', 'ez-library-sentinel')

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
    const caption = h('span', 'ez-library-card-caption', sourceName(item.source))
    button.append(media, caption)
    decorate(button, item, index)
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
    empty.append(...blank())
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

  return {
    searchBox,
    search,
    tagRow,
    grid,
    empty,
    sentinel,
    items: () => items,
    tags: () => tags,
    show: () => {
      if (items.length === 0 && !loading && generation === 0) {
        void loadTags()
        void load(true)
      } else void refresh()
    },
    showNewest: () => {
      search.value = ''
      chosen.clear()
      reload()
      void loadTags()
    },
    loadTags,
    replace: (item) => {
      const at = items.findIndex((i) => i.id === item.id)
      if (at < 0) return
      items[at] = item
      grid.children[at]?.replaceWith(card(item, at))
    },
    remove: (id) => {
      items = items.filter((i) => i.id !== id)
      paintGrid()
    },
  }
}

function cardLabel(item: LibraryItemWire): string {
  const parts = [sourceName(item.source)]
  if (item.tags.length) parts.push(item.tags.join('、'))
  if (item.note) parts.push(item.note)
  return parts.join('，')
}
