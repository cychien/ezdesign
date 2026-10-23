/** One saved reference, large, with what can be changed about it: its tags,
 *  its note, and whether it stays. Edits save as they are made - there is no
 *  form to submit, so closing never loses anything. */

import ArrowUpRight01Icon from '@hugeicons/core-free-icons/ArrowUpRight01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon'
import type { LibraryItemWire, LibraryTagWire } from '../../library-wire.js'
import { normalizeTag, tagKey } from '../../library/policy.js'
import { confirmDialog } from '../confirm-dialog.js'
import { type IconNode, icon } from '../icon.js'
import type { LibraryApi } from './api.js'
import { bytesText, hostOf, playbackText } from './format.js'
import { LIBRARY_TEST_IDS as IDS } from './names.js'

export interface DetailOptions {
  api: LibraryApi
  /** Read on every step, so a step lands on what the grid holds now. */
  items(): readonly LibraryItemWire[]
  index: number
  knownTags(): readonly LibraryTagWire[]
  onChange(item: LibraryItemWire): void
  onRemove(id: string): void
  returnFocus(id: string): HTMLElement | null
}

const NOTE_SAVE_MS = 700
const SUGGESTION_LIMIT = 6

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function iconButton(className: string, label: string, glyph: unknown, size = 16): HTMLButtonElement {
  const button = h('button', className)
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.title = label
  button.append(icon(glyph as IconNode, size))
  return button
}

const dateFormat = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })

export function openDetail(options: DetailOptions): void {
  const { api } = options
  let index = options.index
  let item = options.items()[index]!

  const dialog = h('dialog', 'ez-library-detail')
  dialog.dataset.testid = IDS.detail
  dialog.setAttribute('aria-labelledby', 'ez-library-detail-title')

  const stage = h('div', 'ez-library-detail-stage')
  const prev = iconButton('ez-library-detail-step', '上一個（←）', ArrowLeft01Icon, 18)
  prev.dataset.side = 'prev'
  const next = iconButton('ez-library-detail-step', '下一個（→）', ArrowRight01Icon, 18)
  next.dataset.side = 'next'

  const side = h('div', 'ez-library-detail-side')
  const head = h('header', 'ez-library-detail-head')
  const titleLink = h('a', 'ez-library-detail-title')
  titleLink.id = 'ez-library-detail-title'
  titleLink.target = '_blank'
  titleLink.rel = 'noopener noreferrer'
  const titleText = h('span')
  titleLink.append(titleText, icon(ArrowUpRight01Icon as IconNode, 14))
  const close = iconButton('ez-library-detail-close', '關閉（Esc）', Cancel01Icon)
  const meta = h('p', 'ez-library-detail-meta')
  const notice = h('p', 'ez-library-detail-notice')
  head.append(titleLink, close)

  const tagLabel = h('span', 'ez-library-field-label', '標籤')
  tagLabel.id = 'ez-library-tags-label'
  const chips = h('span', 'ez-library-chips')
  const tagInput = h('input')
  tagInput.type = 'text'
  tagInput.dataset.testid = IDS.tagInput
  tagInput.setAttribute('role', 'combobox')
  tagInput.setAttribute('aria-labelledby', tagLabel.id)
  tagInput.setAttribute('aria-autocomplete', 'list')
  tagInput.setAttribute('aria-controls', 'ez-library-tag-options')
  tagInput.setAttribute('aria-expanded', 'false')
  tagInput.autocomplete = 'off'
  tagInput.spellcheck = false
  const tagBox = h('div', 'ez-library-tag-box')
  tagBox.append(chips, tagInput)
  const optionList = h('ul', 'ez-library-tag-options')
  optionList.id = 'ez-library-tag-options'
  optionList.setAttribute('role', 'listbox')
  optionList.hidden = true
  const combo = h('div', 'ez-library-combo')
  combo.append(tagBox, optionList)
  const tagField = h('div', 'ez-library-field')
  tagField.append(tagLabel, combo)

  const noteLabel = h('label', 'ez-library-field-label', '為什麼好')
  const note = h('textarea', 'ez-library-note')
  note.dataset.testid = IDS.note
  note.id = 'ez-library-note'
  noteLabel.htmlFor = note.id
  note.rows = 5
  note.placeholder = '可留空'
  const noteField = h('div', 'ez-library-field')
  noteField.append(noteLabel, note)

  const status = h('p', 'ez-library-detail-status')
  status.setAttribute('role', 'status')
  const remove = h('button', 'ez-library-detail-remove')
  remove.type = 'button'
  remove.dataset.testid = IDS.remove
  remove.append(icon(Delete02Icon as IconNode, 15), h('span', undefined, '刪除'))
  const foot = h('footer', 'ez-library-detail-foot')
  foot.append(remove, status)

  side.append(head, meta, notice, tagField, noteField, foot)
  const body = h('div', 'ez-library-detail-body')
  body.append(stage, side)
  dialog.append(body)
  document.body.append(dialog)

  let tags: string[] = []
  let highlighted: number | null = null
  let suggestions: string[] = []
  let noteTimer: ReturnType<typeof setTimeout> | undefined
  let statusTimer: ReturnType<typeof setTimeout> | undefined
  /** Saves for this item run one after another, so the last edit is the one kept. */
  let saving: Promise<unknown> = Promise.resolve()

  function say(text: string, tone: 'info' | 'error' = 'info'): void {
    clearTimeout(statusTimer)
    status.textContent = text
    status.dataset.tone = tone
    if (tone === 'info') statusTimer = setTimeout(() => (status.textContent = ''), 1600)
  }

  function save(patch: { tags?: string[]; note?: string }): Promise<unknown> {
    const id = item.id
    saving = saving.then(async () => {
      try {
        const saved = await api.update(id, patch)
        if (item.id === id) item = saved
        options.onChange(saved)
        say('已儲存')
      } catch (error) {
        say(`沒存到：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    })
    return saving
  }

  function flushNote(): void {
    clearTimeout(noteTimer)
    noteTimer = undefined
    if (note.value !== item.note) void save({ note: note.value })
  }

  function paintMedia(): void {
    const original = item.original
    const isVideoFile = item.kind === 'video' && !item.link && original
    let media: HTMLElement
    if (isVideoFile) {
      const video = h('video', 'ez-library-detail-media')
      video.src = original.url
      video.controls = true
      video.playsInline = true
      video.preload = 'metadata'
      if (item.thumbnail) video.poster = item.thumbnail.url
      media = video
    } else if (original || item.thumbnail) {
      const img = h('img', 'ez-library-detail-media')
      img.src = (original ?? item.thumbnail)!.url
      img.alt = item.source.pageTitle
      media = img
    } else {
      media = h('p', 'ez-library-detail-missing', '沒有可以顯示的畫面')
    }
    stage.replaceChildren(media, prev, next)
    const list = options.items()
    prev.hidden = index <= 0
    next.hidden = index >= list.length - 1
  }

  function paintTags(): void {
    chips.replaceChildren(
      ...tags.map((name, at) => {
        const chip = h('button', 'ez-library-chip')
        chip.type = 'button'
        chip.setAttribute('aria-label', `移除標籤 ${name}`)
        chip.append(h('span', undefined, name), h('span', 'ez-library-chip-x', '×'))
        chip.onclick = () => {
          setTags(tags.filter((_, i) => i !== at))
          tagInput.focus()
        }
        return chip
      }),
    )
    tagInput.placeholder = tags.length ? '' : '以 Enter 或逗號加入'
  }

  function setTags(nextTags: string[]): void {
    const same = nextTags.length === tags.length && nextTags.every((t, i) => t === tags[i])
    tags = nextTags
    paintTags()
    if (!same) void save({ tags })
  }

  function addTag(raw: string): boolean {
    const name = normalizeTag(raw)
    if (!name) return false
    const known = options.knownTags().find((t) => tagKey(t.name) === tagKey(name))
    if (!tags.some((t) => tagKey(t) === tagKey(name))) setTags([...tags, known?.name ?? name])
    return true
  }

  function paintSuggestions(): void {
    const draft = tagKey(tagInput.value)
    suggestions = draft
      ? options
          .knownTags()
          .map((t) => t.name)
          .filter((name) => tagKey(name).startsWith(draft) && !tags.some((t) => tagKey(t) === tagKey(name)))
          .slice(0, SUGGESTION_LIMIT)
      : []
    if (highlighted !== null && highlighted >= suggestions.length) highlighted = null
    const open = suggestions.length > 0 && document.activeElement === tagInput
    optionList.hidden = !open
    tagInput.setAttribute('aria-expanded', String(open))
    optionList.replaceChildren(
      ...suggestions.map((name, at) => {
        const option = h('li', undefined, name)
        option.id = `ez-library-tag-option-${at}`
        option.setAttribute('role', 'option')
        option.setAttribute('aria-selected', String(at === highlighted))
        option.addEventListener('mousedown', (e) => {
          e.preventDefault()
          pick(name)
        })
        return option
      }),
    )
    if (open && highlighted !== null) tagInput.setAttribute('aria-activedescendant', `ez-library-tag-option-${highlighted}`)
    else tagInput.removeAttribute('aria-activedescendant')
  }

  function pick(name: string): void {
    addTag(name)
    tagInput.value = ''
    highlighted = null
    paintSuggestions()
  }

  tagInput.addEventListener('input', () => {
    if (/[,，]/.test(tagInput.value)) {
      const parts = tagInput.value.split(/[,，]/)
      const draft = parts.pop() ?? ''
      for (const part of parts) addTag(part)
      tagInput.value = draft
    }
    highlighted = null
    paintSuggestions()
  })
  tagInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length) {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      highlighted = highlighted === null ? (step > 0 ? 0 : suggestions.length - 1) : (highlighted + step + suggestions.length) % suggestions.length
      paintSuggestions()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted !== null) pick(suggestions[highlighted]!)
      else if (addTag(tagInput.value)) {
        tagInput.value = ''
        paintSuggestions()
      }
    } else if (e.key === 'Tab' && highlighted !== null && !optionList.hidden) {
      e.preventDefault()
      pick(suggestions[highlighted]!)
    } else if (e.key === 'Backspace' && tagInput.value === '' && tags.length) {
      setTags(tags.slice(0, -1))
    } else if (e.key === 'Escape' && !optionList.hidden) {
      e.preventDefault()
      suggestions = []
      optionList.hidden = true
      tagInput.setAttribute('aria-expanded', 'false')
    }
  })
  tagInput.addEventListener('blur', () => {
    if (addTag(tagInput.value)) tagInput.value = ''
    paintSuggestions()
  })
  tagBox.addEventListener('mousedown', (e) => {
    if (e.target === tagBox || e.target === chips) {
      e.preventDefault()
      tagInput.focus()
    }
  })

  note.addEventListener('input', () => {
    clearTimeout(noteTimer)
    noteTimer = setTimeout(flushNote, NOTE_SAVE_MS)
  })
  note.addEventListener('blur', flushNote)

  function paint(): void {
    titleText.textContent = item.source.pageTitle || hostOf(item.source.pageUrl)
    titleLink.href = item.source.pageUrl
    titleLink.title = item.source.pageUrl
    const where = [hostOf(item.source.pageUrl), dateFormat.format(item.source.capturedAt)]
    const size: string[] = []
    if (item.dimensions) size.push(`${item.dimensions.width} × ${item.dimensions.height}`)
    if (item.original && !item.link) size.push(bytesText(item.original.bytes))
    meta.replaceChildren(
      ...[where, size].filter((group) => group.length).map((group) => h('span', undefined, group.join(' · '))),
    )
    notice.hidden = !item.link
    if (item.link) {
      const at = item.link.playbackTime !== null ? `，停在 ${playbackText(item.link.playbackTime)}` : ''
      notice.textContent =
        item.link.reason === 'stream'
          ? `串流影片只存了連結和當下的畫面${at}`
          : `影片超過 200 MB，只存了連結和畫面${at}`
    }
    tags = [...item.tags]
    tagInput.value = ''
    paintTags()
    note.value = item.note
    clearTimeout(statusTimer)
    status.textContent = ''
    paintMedia()
  }

  function step(delta: number): void {
    const list = options.items()
    const at = list.findIndex((i) => i.id === item.id)
    const target = list[(at < 0 ? index : at) + delta]
    if (!target) return
    flushNote()
    index = list.indexOf(target)
    item = target
    paint()
  }

  let closed = false
  function finish(): void {
    if (closed) return
    closed = true
    flushNote()
    const id = item.id
    dialog.close()
    dialog.remove()
    options.returnFocus(id)?.focus()
  }

  prev.onclick = () => step(-1)
  next.onclick = () => step(1)
  close.onclick = finish
  remove.onclick = async () => {
    const sure = await confirmDialog({
      title: '刪除這個素材？',
      body: '它會從素材庫消失，標籤和筆記一起刪除。',
      go: '刪除',
      testId: IDS.confirm,
    })
    if (!sure) return
    const gone = item
    try {
      await saving
      await api.remove(gone.id)
    } catch (error) {
      say(`沒刪掉：${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    const list = options.items()
    const at = list.findIndex((i) => i.id === gone.id)
    options.onRemove(gone.id)
    const rest = options.items()
    const landing = rest[Math.min(at, rest.length - 1)]
    if (!landing) return finish()
    index = rest.indexOf(landing)
    item = landing
    paint()
  }

  // Only the backdrop is the dialog itself: the body covers all of its box.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) finish()
  })
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault()
    finish()
  })
  dialog.addEventListener('keydown', (e) => {
    // The shell's keys (element mode, device sizes) must not act behind it.
    e.stopPropagation()
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'ArrowLeft') step(-1)
    else if (e.key === 'ArrowRight') step(1)
  })

  paint()
  dialog.showModal()
  close.focus()
}
