/** The tab strip and the 所有 canvas menu: a pure model from the snapshot, and
 *  the painter that draws it with the names in `names.ts`.
 *
 *  The tabs are derived, never stored: the App tab exists while an origin is
 *  attached, a canvas tab while its canvas is not archived. Only the active tab
 *  is state, and the daemon holds it. */

import type { CanvasId, CanvasSummary, TabId } from '../../canvas/types.js'
import type { CanvasSnapshotWire } from '../../canvas/wire.js'
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
    create.textContent = '+'
    create.onclick = () => handlers.create()

    this.menuWrap = h('div', 'ez-canvas-menu-wrap')
    this.menuButton = h('button', 'ez-canvas-menu', LABELS.canvasMenu)
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
    el.append(name)
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

  private beginRename(tabEl: HTMLElement, id: CanvasId, current: string): void {
    this.renaming = id
    const input = h('input', 'ez-tab-rename')
    input.value = current
    input.setAttribute('aria-label', 'canvas 名稱')
    const name = tabEl.querySelector('.ez-tab-name')!
    name.replaceWith(input)
    input.focus()
    input.select()
    let settled = false
    const finish = (commit: boolean) => {
      if (settled) return
      settled = true
      this.renaming = null
      const next = input.value.trim()
      if (commit && next && next !== current) this.handlers.rename(id, next)
      this.drawn = null
      this.paint(this.model)
      this.tabNode(id)?.focus()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') finish(true)
      if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('click', (e) => e.stopPropagation())
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
      open.append(
        h('span', 'ez-menu-name', c.name),
        h('span', 'ez-canvas-menu-meta', c.archived ? '已關閉' : `${c.frames} 個 frame`),
      )
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
      row.append(open)
      if (c.archived) {
        const del = h('button', 'ez-canvas-menu-delete', '刪除')
        del.setAttribute('role', 'menuitem')
        del.setAttribute('aria-label', LABELS.delete(c.name))
        del.title = LABELS.delete(c.name)
        del.onclick = () => {
          this.toggleMenu(false)
          this.handlers.delete(c.id, c.name)
        }
        row.append(del)
      }
      return row
    })
    if (!items.length) items.push(h('div', 'ez-canvas-menu-empty', '還沒有 canvas'))
    this.menu.replaceChildren(...items)
  }
}
