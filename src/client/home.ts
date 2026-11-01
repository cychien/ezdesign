import { Cancel01Icon, Folder01Icon, FolderAddIcon, PlusSignIcon, SidebarLeftIcon, StopIcon } from '@hugeicons/core-free-icons'
import { brandLockupSvg, brandMarkSvg } from '../brand.js'
import type { ProjectListWire, ProjectWire } from '../projects/wire.js'
import { type Host, host } from './host.js'
import { type IconNode, icon } from './icon.js'
import { devServerStatus, projectsClient } from './projects.js'

export const LIST_SHOWN_MARK = 'ez:list-shown'

export const HOME_TEST_IDS = {
  list: 'ez-side-list',
  row: 'ez-side-row',
  add: 'ez-side-add',
} as const

type DesktopHost = Extract<Host, { kind: 'desktop' }>

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconButton(glyph: IconNode, label: string, className = 'ez-side-icon'): HTMLButtonElement {
  const b = h('button', className)
  b.type = 'button'
  b.title = label
  b.setAttribute('aria-label', label)
  b.append(icon(glyph, 15))
  return b
}

function appOnlyNote(): HTMLElement {
  const page = h('main', 'ez-home')
  const head = h('header', 'ez-home-head')
  const brand = h('div', 'ez-logo')
  brand.setAttribute('role', 'img')
  brand.setAttribute('aria-label', 'ezdesign')
  brand.innerHTML = brandLockupSvg()
  head.append(brand)
  page.append(
    head,
    h('p', 'ez-home-lead ez-home-app-only', '專案列表在 ezdesign 的 Mac app 裡使用。要 review 一個專案，請在它的資料夾裡執行 npx -y @cychien/ezdesign。'),
  )
  return page
}

/** The app's two panes over the daemon's project list: the sidebar, and the
 *  pane shown before any project is opened. A browser gets only a note. */
export function bootHome(root: HTMLElement, api: string, version: string): void {
  if (host.kind !== 'desktop') return void root.replaceChildren(appOnlyNote())
  const pane = new URLSearchParams(location.search).get('pane')
  if (pane === 'empty') return void root.replaceChildren(emptyPane(host, api, version))
  bootSidebar(root, host, api, version)
}

/** Picked or dropped folders are added and opened at once. */
function addAndOpen(client: ReturnType<typeof projectsClient>, path: string): Promise<void> {
  return client.add(path).then((added) => client.go(added.project))
}

function emptyPane(desktop: DesktopHost, api: string, version: string): HTMLElement {
  const client = projectsClient(api, version)
  const page = h('main', 'ez-empty')
  const mark = h('div', 'ez-empty-mark')
  mark.innerHTML = brandMarkSvg('ez-empty-sunset')
  const error = h('p', 'ez-empty-error')
  const add = h('button', 'ez-home-add-go ez-home-pick')
  add.type = 'button'
  add.append(icon(FolderAddIcon as IconNode, 16), h('span', undefined, '加入新專案'))
  add.onclick = () =>
    void desktop.pickFolder().then((path) => path && addAndOpen(client, path).catch((e: Error) => (error.textContent = e.message)))
  page.append(
    mark,
    h('h1', 'ez-empty-title', '選一個專案開始設計'),
    h('p', 'ez-empty-lead', '從左邊選一個專案，或加入一個新的資料夾。'),
    add,
    error,
  )
  return page
}

function bootSidebar(root: HTMLElement, desktop: DesktopHost, api: string, version: string): void {
  const client = projectsClient(api, version)
  let list: ProjectListWire | null = null
  let shown: string | null = null
  /** Projects whose agent finished a turn while another was on screen: green until opened. */
  const unseen = new Set<string>()
  let error: string | null = null

  const side = h('nav', 'ez-side')
  side.setAttribute('aria-label', '專案')
  const top = h('header', 'ez-side-top')
  const collapse = iconButton(SidebarLeftIcon as IconNode, '收合側邊欄（⌃⌘S）')
  collapse.onclick = () => desktop.toggleSidebar()
  top.append(collapse)

  const section = h('div', 'ez-side-section')
  const add = iconButton(PlusSignIcon as IconNode, '加入新專案（⌘O）')
  add.dataset.testid = HOME_TEST_IDS.add
  add.onclick = () => void desktop.pickFolder().then((path) => path && open(() => addAndOpen(client, path)))
  section.append(h('span', 'ez-side-label', '專案'), add)

  const rows = h('ul', 'ez-side-list')
  rows.dataset.testid = HOME_TEST_IDS.list
  const errorLine = h('p', 'ez-side-error')
  errorLine.setAttribute('role', 'alert')
  side.append(top, section, rows, errorLine)
  root.replaceChildren(side, h('div', 'ez-side-grip'))

  function open(go: () => Promise<void>): void {
    error = null
    paint()
    go()
      .catch((e: Error) => (error = e.message))
      .finally(paint)
  }

  function row(project: ProjectWire): HTMLElement {
    const item = h('li', 'ez-side-row')
    item.dataset.testid = HOME_TEST_IDS.row
    item.toggleAttribute('data-current', project.project === shown)
    item.toggleAttribute('data-missing', !project.exists)
    const pick = h('button', 'ez-side-open')
    pick.type = 'button'
    pick.title = project.exists ? project.project : `${project.project}（資料夾不見了）`
    pick.disabled = !project.exists
    pick.append(icon(Folder01Icon as IconNode, 15), h('span', 'ez-side-name', project.name))
    const agent = project.session?.agentWorking ? 'working' : unseen.has(project.project) ? 'done' : null
    if (agent) {
      const dot = h('span', 'ez-side-agent')
      dot.dataset.state = agent
      dot.title = agent === 'working' ? 'Agent 工作中' : 'Agent 做完了'
      pick.append(dot)
    }
    pick.onclick = () => open(() => client.go(project.project))
    item.append(pick)

    const actions = h('span', 'ez-side-actions')
    const status = devServerStatus(project)
    if (status && (status.phase === 'running' || status.phase === 'starting')) {
      const stop = iconButton(StopIcon as IconNode, `停止 ${project.name} 的 dev server`)
      stop.onclick = () => void client.stop(project.project).catch((e: Error) => ((error = e.message), paint()))
      actions.append(stop)
    }
    const hide = iconButton(Cancel01Icon as IconNode, `從列表移除 ${project.name}（資料夾和 .ezdesign 都會保留）`)
    hide.onclick = () => void client.hide(project.project).catch((e: Error) => ((error = e.message), paint()))
    actions.append(hide)
    item.append(actions)
    return item
  }

  function paint(): void {
    errorLine.textContent = error ?? ''
    errorLine.hidden = !error
    if (!list) return
    if (!list.projects.length) {
      const empty = h('li', 'ez-side-empty', '按 + 或把專案資料夾拖進來。')
      rows.replaceChildren(empty)
      return
    }
    rows.replaceChildren(...list.projects.map(row))
  }

  document.addEventListener('dragover', (e) => {
    e.preventDefault()
    side.toggleAttribute('data-dragging', true)
  })
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) side.toggleAttribute('data-dragging', false)
  })
  document.addEventListener('drop', (e) => {
    e.preventDefault()
    side.toggleAttribute('data-dragging', false)
    const file = e.dataTransfer?.files[0]
    const path = file ? desktop.pathForFile(file) : ''
    if (path) open(() => addAndOpen(client, path))
  })

  desktop.onLayout((layout) => {
    shown = layout.shown
    if (shown) unseen.delete(shown)
    paint()
  })
  client.watch((next) => {
    for (const project of next.projects) {
      const before = list?.projects.find((p) => p.project === project.project)?.session?.agentWorking
      if (before && !project.session?.agentWorking && project.project !== shown) unseen.add(project.project)
    }
    list = next
    paint()
    if (!performance.getEntriesByName(LIST_SHOWN_MARK).length) performance.mark(LIST_SHOWN_MARK)
  })
  paint()
}
