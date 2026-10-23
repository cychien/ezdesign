import { deviceCrop } from '../shared/geometry.js'
import {
  type CaptureView,
  DIALOG_PORT_PREFIX,
  type DialogLeaving,
  type DialogToWorker,
  type PreviewHandoff,
  type PreviewSource,
  type WorkerToDialog,
} from '../shared/messages.js'
import { type TagField, allTags, emptyTags, reduceTags } from './tags.js'

const captureId = location.hash.slice(1)
const inWindow = window.top === window
document.documentElement.dataset.where = inWindow ? 'window' : 'page'

const port = chrome.runtime.connect({ name: DIALOG_PORT_PREFIX + captureId })
const post = (message: DialogToWorker) => port.postMessage(message)
const now = () => performance.timeOrigin + performance.now()

const TAG_PLACEHOLDER = '可留空或多個，以 Enter 或逗號隔開'
const STREAM_NOTICE = '串流影片只會儲存連結、目前時間和畫面'
const TOO_LARGE_NOTICE = '影片超過 200 MB，只會儲存連結和畫面'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  node.append(...children)
  return node
}

const overlay = el('div', { class: 'overlay' })
const card = el('section', { class: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ez-title' })
const title = el('h1', { id: 'ez-title' }, '儲存至 ezdesign')
const source = el('p', { class: 'source' })
const figure = el('figure', { class: 'preview', hidden: '' })
const chipList = el('span', { class: 'chips' })
const tagInput = el('input', {
  type: 'text',
  role: 'combobox',
  'aria-label': '標籤',
  'aria-autocomplete': 'list',
  'aria-expanded': 'false',
  'aria-controls': 'ez-suggestions',
  'data-testid': 'ez-capture-tag-input',
  placeholder: TAG_PLACEHOLDER,
  autocomplete: 'off',
  spellcheck: 'false',
})
const tagBox = el('div', { class: 'tags' }, chipList, tagInput)
const suggestionList = el('ul', {
  id: 'ez-suggestions',
  role: 'listbox',
  'aria-label': '標籤建議',
  'data-testid': 'ez-capture-tag-suggestions',
  hidden: '',
})
const note = el('textarea', { 'aria-label': '為什麼好', 'data-testid': 'ez-capture-note', rows: '3', placeholder: '可留空' })
const status = el('p', { class: 'status', role: 'status', 'data-testid': 'ez-capture-status' })
const installCode = el('code')
const copyButton = el('button', { type: 'button', class: 'quiet' }, '複製')
const install = el('div', { class: 'install', 'data-testid': 'ez-capture-install', hidden: '' }, installCode, copyButton)
const grantButton = el('button', { type: 'button', class: 'grant', hidden: '' })
const cancelButton = el('button', { type: 'button', 'data-testid': 'ez-capture-cancel' }, '取消')
const saveButton = el('button', { type: 'button', class: 'primary', 'data-testid': 'ez-capture-save' }, '儲存')

const header = el('header', {}, title, source)
card.append(
  ...(inWindow ? [header, figure] : [figure, header]),
  el('div', { class: 'field' }, el('span', { class: 'label', 'aria-hidden': 'true' }, '標籤'), el('div', { class: 'combo' }, tagBox, suggestionList)),
  el('div', { class: 'field' }, el('span', { class: 'label', 'aria-hidden': 'true' }, '為什麼好'), note),
  status,
  install,
  grantButton,
  el('footer', {}, cancelButton, saveButton),
)
overlay.append(card)
document.body.append(overlay)

let view: CaptureView | null = null
let tags: TagField = emptyTags
let suggestions: { name: string; uses: number }[] = []
let prefilled = false
let closing = false
let previewNonce: string | null = null
let handoff: PreviewHandoff | null = null

function drawHandoff(): void {
  if (previewNonce === null || handoff === null || handoff.nonce !== previewNonce) return
  const { bitmap } = handoff
  previewNonce = null
  handoff = null
  drawPreview(bitmap, bitmap.width, bitmap.height)
}

function renderTags(): void {
  const locked = tags.locked.map((name) => el('span', { class: 'chip locked', title: '已收藏過的標籤' }, name))
  const chips = tags.chips.map((name, index) => {
    const chip = el('button', { type: 'button', class: 'chip', 'aria-label': `移除標籤 ${name}` }, el('span', {}, name), el('span', { class: 'x', 'aria-hidden': 'true' }, '×'))
    chip.addEventListener('click', () => {
      tags = reduceTags(tags, { type: 'remove', index }, [])
      renderTags()
      tagInput.focus()
      requestSuggestions()
    })
    return chip
  })
  chipList.replaceChildren(...locked, ...chips)
  tagInput.placeholder = locked.length + chips.length ? '' : TAG_PLACEHOLDER
  if (tagInput.value !== tags.draft) tagInput.value = tags.draft
  renderSuggestions()
}

function renderSuggestions(): void {
  const open = tags.draft.trim() !== '' && suggestions.length > 0
  suggestionList.hidden = !open
  tagInput.setAttribute('aria-expanded', String(open))
  suggestionList.replaceChildren(
    ...suggestions.map((tag, index) => {
      const option = el(
        'li',
        { role: 'option', id: `ez-suggestion-${index}`, 'aria-selected': String(index === tags.highlighted) },
        el('span', { class: 'name' }, tag.name),
        el('span', { class: 'uses' }, String(tag.uses)),
      )
      if (index === tags.highlighted) option.dataset.active = ''
      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
        pick(tag.name)
      })
      return option
    }),
  )
  if (open && tags.highlighted !== null) tagInput.setAttribute('aria-activedescendant', `ez-suggestion-${tags.highlighted}`)
  else tagInput.removeAttribute('aria-activedescendant')
}

function requestSuggestions(): void {
  if (tags.draft.trim() === '') {
    suggestions = []
    renderSuggestions()
    return
  }
  post({ type: 'suggest', prefix: tags.draft.trim(), exclude: allTags(tags) })
}

function pick(name: string): void {
  tags = reduceTags(tags, { type: 'pick', name }, [])
  suggestions = []
  renderTags()
  tagInput.focus()
}

const names = () => suggestions.map((s) => s.name)

tagInput.addEventListener('input', () => {
  const before = tags.chips.length
  tags = reduceTags(tags, { type: 'input', value: tagInput.value }, names())
  if (tags.chips.length !== before) suggestions = []
  renderTags()
  requestSuggestions()
})

tagInput.addEventListener('keydown', (event) => {
  if (event.isComposing) return
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
    event.preventDefault()
    tags = reduceTags(tags, { type: 'arrow', delta: event.key === 'ArrowDown' ? 1 : -1 }, names())
    renderSuggestions()
  } else if (event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    tags = reduceTags(tags, { type: 'enter' }, names())
    suggestions = []
    renderTags()
  } else if (event.key === 'Tab' && tags.highlighted !== null && !suggestionList.hidden) {
    event.preventDefault()
    pick(suggestions[tags.highlighted]!.name)
  } else if (event.key === 'Backspace' && tagInput.value === '') {
    tags = reduceTags(tags, { type: 'backspace' }, names())
    renderTags()
  }
})

tagInput.addEventListener('blur', () => {
  suggestions = []
  renderSuggestions()
})

function confirm(): void {
  if (closing || !view || view.confirm !== 'enabled') return
  if (tags.draft.trim()) tags = reduceTags(tags, { type: 'enter' }, [])
  tags = { ...tags, highlighted: null }
  renderTags()
  post({ type: 'confirm', tags: allTags(tags), note: note.value })
}

function leave(how: 'saved' | 'cancelled'): void {
  if (closing) return
  closing = true
  document.documentElement.dataset.leaving = how
  if (!inWindow) window.parent.postMessage({ type: 'ez-capture-leaving', how } satisfies DialogLeaving, '*')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const done = () => post({ type: 'closed' })
  if (reduced) setTimeout(done, 120)
  else card.addEventListener('animationend', done, { once: true })
}

function cancel(): void {
  if (closing) return
  post({ type: 'cancel' })
  leave('cancelled')
}

saveButton.addEventListener('click', confirm)
cancelButton.addEventListener('click', cancel)
overlay.addEventListener('mousedown', (event) => {
  if (event.target === overlay) cancel()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!suggestionList.hidden) {
      suggestions = []
      renderSuggestions()
    } else {
      cancel()
    }
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    confirm()
  }
})

copyButton.addEventListener('click', () => {
  void navigator.clipboard.writeText(installCode.textContent ?? '').then(() => {
    copyButton.textContent = '已複製'
    setTimeout(() => (copyButton.textContent = '複製'), 1500)
  })
})

grantButton.addEventListener('click', () => {
  const origin = grantButton.dataset.origin
  if (!origin) return
  grantButton.disabled = true
  // The request has to run in this click: Chrome only prompts inside a user gesture.
  void chrome.permissions.request({ origins: [`${origin}/*`] }).then(
    (granted) => post({ type: granted ? 'granted' : 'denied', origin }),
    () => post({ type: 'denied', origin }),
  )
})

function hostText(v: CaptureView): string | null {
  switch (v.host.type) {
    case 'missing':
      return '還沒有安裝 ezdesign host，在終端機執行這行指令後再存一次：'
    case 'incompatible':
      return v.host.older === 'host'
        ? 'ezdesign host 版本太舊，更新後再存一次：'
        : '這個擴充功能版本太舊，更新後再存一次：'
    case 'broken':
      return v.host.message
    default:
      return null
  }
}

function render(v: CaptureView): void {
  view = v
  source.textContent = v.page.title || v.page.url
  source.title = v.page.url
  if (v.duplicate && !prefilled) {
    prefilled = true
    tags = reduceTags(tags, { type: 'lock', names: v.duplicate.tags }, [])
    if (note.value === '') note.value = v.duplicate.note
    renderTags()
  }
  const hostProblem = hostText(v)
  const installCommand = v.host.type === 'missing' || v.host.type === 'incompatible' ? v.host.installCommand : null
  install.hidden = installCommand === null
  installCode.textContent = installCommand ?? ''

  const permission = v.staging.type === 'needs-permission' ? v.staging.origin : null
  grantButton.hidden = permission === null
  if (permission) {
    grantButton.dataset.origin = permission
    grantButton.textContent = `允許讀取 ${permission}`
    grantButton.disabled = false
  }

  const line =
    hostProblem ??
    v.error ??
    (v.staging.type === 'failed' ? v.staging.message : null) ??
    (permission ? '這張圖片需要你在這個網站的登入狀態才能讀取。' : null) ??
    (v.notice === 'stream-link' ? STREAM_NOTICE : v.notice === 'too-large' ? TOO_LARGE_NOTICE : null) ??
    (v.duplicate ? '已收藏過' : '')
  status.textContent = line
  status.dataset.tone = hostProblem || v.error || v.staging.type === 'failed' ? 'error' : 'info'

  saveButton.disabled = v.confirm !== 'enabled'
  saveButton.textContent = v.confirm === 'saving' ? '儲存中…' : v.confirm === 'saved' ? '已儲存' : '儲存'
  saveButton.setAttribute('aria-busy', String(v.confirm === 'saving'))
  if (v.confirm === 'saved') leave('saved')
}

function drawPreview(image: CanvasImageSource, width: number, height: number, crop?: { x: number; y: number; width: number; height: number }) {
  const box = crop ?? { x: 0, y: 0, width, height }
  figure.hidden = false
  const padding = getComputedStyle(figure)
  const maxWidth = figure.clientWidth - Number.parseFloat(padding.paddingLeft) - Number.parseFloat(padding.paddingRight)
  const maxHeight = Math.max(96, Math.min(300, innerHeight - 400))
  const scale = Math.min(1, maxWidth / box.width, maxHeight / box.height)
  const canvas = el('canvas', { 'data-testid': 'ez-capture-preview', role: 'img', 'aria-label': '預覽' })
  canvas.style.width = `${Math.round(box.width * scale)}px`
  canvas.width = Math.max(1, Math.round(box.width * scale * devicePixelRatio))
  canvas.height = Math.max(1, Math.round(box.height * scale * devicePixelRatio))
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height)
  figure.replaceChildren(canvas)
  requestAnimationFrame(() => post({ type: 'preview-shown', at: now() }))
}

async function showPreview(preview: PreviewSource): Promise<void> {
  switch (preview.type) {
    case 'bitmap':
      previewNonce = preview.nonce
      drawHandoff()
      return
    case 'screenshot': {
      const image = new Image()
      image.src = preview.dataUrl
      await image.decode()
      const size = { width: image.naturalWidth, height: image.naturalHeight }
      drawPreview(image, size.width, size.height, preview.rect ? deviceCrop(preview.rect, preview.viewport, size) : undefined)
      return
    }
    case 'url': {
      const image = el('img', { 'data-testid': 'ez-capture-preview', alt: '預覽', src: preview.src })
      figure.replaceChildren(image)
      figure.hidden = false
      await image.decode().catch(() => {})
      requestAnimationFrame(() => post({ type: 'preview-shown', at: now() }))
      return
    }
    case 'none':
      return
  }
}

window.addEventListener('message', (event) => {
  const data = event.data as PreviewHandoff | null
  if (event.source !== window.parent || data?.type !== 'ez-capture-preview') return
  handoff = data
  drawHandoff()
})

port.onMessage.addListener((raw) => {
  const message = raw as WorkerToDialog
  if (message.type === 'preview') void showPreview(message.preview)
  else if (message.type === 'view') render(message.view)
  else if (message.type === 'suggestions' && message.prefix === tags.draft.trim()) {
    suggestions = message.tags
    tags = { ...tags, highlighted: null }
    renderSuggestions()
  }
})

port.onDisconnect.addListener(() => leave('cancelled'))

// The page hands the iframe focus only after it loads, and a focus() before
// that does not stick, so the tag field takes it when the window does.
window.addEventListener('focus', () => {
  if (!closing && (document.activeElement === document.body || document.activeElement === null)) tagInput.focus()
})
tagInput.focus()
