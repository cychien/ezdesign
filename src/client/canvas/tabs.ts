/** The tab strip and the Canvas menu: a pure model from the snapshot, and
 *  the painter that draws it with the names in `names.ts`.
 *
 *  The tabs are derived, never stored: the App tab exists while an origin is
 *  attached, a canvas tab while its canvas is not archived. Only the active tab
 *  is state, and the daemon holds it. */

import CanvasIcon from '@hugeicons/core-free-icons/CanvasIcon'
import PlusIcon from '@hugeicons/core-free-icons/PlusIcon'
import WebDesign01Icon from '@hugeicons/core-free-icons/WebDesign01Icon'
import { type CanvasId, type CanvasSummary, MAX_CANVAS_NAME, type TabId } from '../../canvas/types.js'
import type { CanvasSnapshotWire } from '../../canvas/wire.js'
import { type IconNode, icon } from '../icon.js'
import { LABELS, TEST_IDS } from './names.js'

export interface Tab {
  id: TabId
  /** The accessible name, from `LABELS`. */
  label: string
  /** The App tab does not close: it goes when its dev server is detached. */
  closable: boolean
}

export interface TabsModel {
  tabs: Tab[]
  /** The daemon's active tab when it names one that exists, else the first: a
   *  stale one (archived in another window) never leaves the strip blank. */
  active: TabId | null
  /** For the menu: every canvas, open and archived, newest first. */
  all: CanvasSummary[]
}

/** App first when attached, then open canvases by `createdAt`. */
export function tabsModel(app: string | undefined, canvas: CanvasSnapshotWire): TabsModel {
  const open = canvas.canvases
    .filter((c) => !c.archived)
    .sort((a, b) => a.createdAt - b.createdAt)
  const tabs: Tab[] = [
    ...(app ? [{ id: 'app' as const, label: LABELS.appTab, closable: false }] : []),
    ...open.map((c) => ({ id: c.id, label: LABELS.canvasTab(c.name), closable: true })),
  ]
  const active = tabs.some((t) => t.id === canvas.activeTab)
    ? canvas.activeTab
    : (tabs[0]?.id ?? null)
  const all = [...canvas.canvases].sort((a, b) => b.createdAt - a.createdAt)
  return { tabs, active, all }
}

export interface TabStripHandlers {
  select(tab: TabId): void
  /** Archives. */
  close(canvasId: CanvasId): void
  create(): void
  /** Double-click on a canvas tab's label: rename in place, Enter commits. */
  rename(canvasId: CanvasId, name: string): void
  reopen(canvasId: CanvasId): void
  /** Asks first. */
  delete(canvasId: CanvasId, name: string): void
}

const RENAME_SAVE_MS = 400

type Make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) => HTMLElementTagNameMap[K]

const h: Make = (tag, className, text) => {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/** `role=tablist` with roving focus: Left/Right move, Enter/Space select,
 *  Delete closes. Painted by a signature of the model, so a snapshot per agent
 *  token rebuilds nothing and focus stays put. */
export class TabStrip {
  readonly el: HTMLElement
  private readonly list: HTMLElement
  private readonly menuWrap: HTMLElement
  private readonly menuButton: HTMLButtonElement
  private readonly menu: HTMLElement
  private drawn: string | null = null
  private model: TabsModel = { tabs: [], active: null, all: [] }
  private renaming: CanvasId | null = null

  constructor(private readonly handlers: TabStripHandlers) {
    this.el = h('div', 'ez-tabs-bar')
    this.list = h('div', 'ez-tabs')
    this.list.dataset.testid = TEST_IDS.tabs
    this.list.setAttribute('role', 'tablist')
    this.list.setAttribute('aria-label', LABELS.tabs)
    this.list.addEventListener('keydown', (e) => this.onKey(e))

    const create = h('button', 'ez-tab-new')
    create.dataset.testid = TEST_IDS.newCanvas
    create.setAttribute('aria-label', LABELS.newCanvas)
    create.title = LABELS.newCanvas
    create.append(icon(PlusIcon as IconNode, 14))
    create.onclick = () => handlers.create()

    this.menuWrap = h('div', 'ez-canvas-menu-wrap')
    this.menuButton = h('button', 'ez-canvas-menu')
    this.menuButton.append(icon(CanvasIcon as IconNode, 16))
    this.menuButton.setAttribute('aria-label', LABELS.canvasMenu)
    this.menuButton.title = LABELS.canvasMenu
    this.menuButton.dataset.testid = TEST_IDS.canvasMenu
    this.menuButton.setAttribute('aria-haspopup', 'menu')
    this.menuButton.setAttribute('aria-expanded', 'false')
    this.menuButton.onclick = () => this.toggleMenu()
    this.menu = h('div', 'ez-menu ez-menu-right ez-canvas-menu-list')
    this.menu.dataset.testid = TEST_IDS.canvasMenuList
    this.menu.setAttribute('role', 'menu')
    this.menu.setAttribute('aria-label', LABELS.canvasMenu)
    this.menuWrap.append(this.menuButton, this.menu)
    this.menuWrap.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.menuWrap.hasAttribute('data-open')) return
      e.stopPropagation()
      this.toggleMenu(false)
      this.menuButton.focus()
    })
    document.addEventListener('click', (e) => {
      if (e.target instanceof Node && !this.menuWrap.contains(e.target)) this.toggleMenu(false)
    })

    const tail = h('div', 'ez-tabs-tail')
    tail.append(create, this.menuWrap)
    this.el.append(this.list, tail)
  }

  paint(model: TabsModel): void {
    this.model = model
    const signature = JSON.stringify(model)
    if (signature === this.drawn || this.renaming) return
    this.drawn = signature
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.tab
    this.list.replaceChildren(...model.tabs.map((tab) => this.tabEl(tab, tab.id === model.active)))
    if (focused) this.tabNode(focused)?.focus()
    this.paintMenu()
  }

  private tabNode(id: string): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)
  }

  private tabEl(tab: Tab, active: boolean): HTMLElement {
    const el = h('div', 'ez-tab')
    el.dataset.tab = tab.id
    el.dataset.testid = tab.id === 'app' ? TEST_IDS.appTab : TEST_IDS.canvasTab
    if (tab.id !== 'app') el.dataset.canvasId = tab.id
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(active))
    el.setAttribute('aria-label', tab.label)
    el.tabIndex = active ? 0 : -1
    const name = h('span', 'ez-tab-name', tab.label)
    const label = h('span', 'ez-tab-label')
    if (tab.id === 'app') label.append(icon(WebDesign01Icon as IconNode, 15))
    label.append(name)
    el.append(label)
    el.onclick = () => this.handlers.select(tab.id)
    if (tab.id !== 'app') {
      const id = tab.id
      name.title = '雙擊重新命名'
      el.ondblclick = (e) => {
        e.preventDefault()
        this.beginRename(el, id, tab.label)
      }
    }
    if (tab.closable && tab.id !== 'app') {
      const id = tab.id
      const close = h('button', 'ez-tab-close', '×')
      close.dataset.testid = TEST_IDS.closeTab
      close.setAttribute('aria-label', LABELS.closeTab(tab.label))
      close.title = LABELS.closeTab(tab.label)
      close.tabIndex = -1
      close.onclick = (e) => {
        e.stopPropagation()
        this.handlers.close(id)
      }
      el.append(close)
    }
    return el
  }

  /** In place on the tab's own name, saved as it is typed; Escape restores the
   *  name it started with. */
  private beginRename(tabEl: HTMLElement, id: CanvasId, original: string): void {
    this.renaming = id
    const name = tabEl.querySelector<HTMLElement>('.ez-tab-name')!
    name.contentEditable = 'plaintext-only'
    name.spellcheck = false
    name.setAttribute('aria-label', 'canvas 名稱')
    tabEl.toggleAttribute('data-renaming', true)
    name.focus()
    getSelection()?.selectAllChildren(name)
    let saved = original
    let pending: ReturnType<typeof setTimeout> | undefined
    const save = (next: string) => {
      clearTimeout(pending)
      if (next && next !== saved) this.handlers.rename(id, (saved = next))
    }
    const typed = () =>
      [...(name.textContent ?? '').replace(/\s+/g, ' ').trim()].slice(0, MAX_CANVAS_NAME).join('')
    let settled = false
    const finish = (restore: boolean) => {
      if (settled) return
      settled = true
      save(restore ? original : typed())
      this.renaming = null
      this.drawn = null
      this.paint(this.model)
      this.tabNode(id)?.focus()
    }
    name.addEventListener('input', () => {
      clearTimeout(pending)
      pending = setTimeout(() => save(typed()), RENAME_SAVE_MS)
    })
    name.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault()
        finish(e.key === 'Escape')
      }
    })
    name.addEventListener('blur', () => finish(false))
    name.addEventListener('click', (e) => e.stopPropagation())
    name.addEventListener('dblclick', (e) => e.stopPropagation())
  }

  private onKey(e: KeyboardEvent): void {
    const tabs = this.model.tabs
    const at = tabs.findIndex((t) => t.id === (e.target as HTMLElement).dataset?.tab)
    if (at < 0) return
    const move = (to: number) => {
      e.preventDefault()
      const tab = tabs[(to + tabs.length) % tabs.length]!
      this.tabNode(tab.id)?.focus()
    }
    if (e.key === 'ArrowRight') move(at + 1)
    else if (e.key === 'ArrowLeft') move(at - 1)
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      this.handlers.select(tabs[at]!.id)
    } else if (e.key === 'Delete' && tabs[at]!.closable && tabs[at]!.id !== 'app') {
      e.preventDefault()
      this.handlers.close(tabs[at]!.id as CanvasId)
    }
  }

  private toggleMenu(open = !this.menuWrap.hasAttribute('data-open')): void {
    this.menuWrap.toggleAttribute('data-open', open)
    this.menuButton.setAttribute('aria-expanded', String(open))
    if (open) this.menu.querySelector<HTMLElement>('button')?.focus()
  }

  private paintMenu(): void {
    const items = this.model.all.map((c) => {
      const row = h('div', 'ez-canvas-menu-item')
      row.dataset.testid = TEST_IDS.canvasMenuItem
      row.dataset.canvasId = c.id
      row.toggleAttribute('data-archived', c.archived)
      row.setAttribute('role', 'none')
      const open = h('button', 'ez-menu-item ez-canvas-menu-open')
      open.setAttribute('role', 'menuitem')
      open.append(h('span', 'ez-menu-name', c.name))
      if (c.archived) {
        open.setAttribute('aria-label', LABELS.reopen(c.name))
        open.title = LABELS.reopen(c.name)
        open.onclick = () => {
          this.toggleMenu(false)
          this.handlers.reopen(c.id)
        }
      } else {
        open.onclick = () => {
          this.toggleMenu(false)
          this.handlers.select(c.id)
        }
      }
      const del = h('button', 'ez-canvas-menu-delete', '刪除')
      del.setAttribute('role', 'menuitem')
      del.setAttribute('aria-label', LABELS.delete(c.name))
      del.title = LABELS.delete(c.name)
      del.onclick = () => {
        this.toggleMenu(false)
        this.handlers.delete(c.id, c.name)
      }
      row.append(open, del)
      return row
    })
    if (!items.length) items.push(h('div', 'ez-canvas-menu-empty', '還沒有 canvas'))
    this.menu.replaceChildren(...items)
  }
}
