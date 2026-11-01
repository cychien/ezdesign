import {
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  Download04Icon,
  Folder01Icon,
  FolderAddIcon,
  Logout01Icon,
  PlusSignIcon,
  SidebarLeftIcon,
  StopIcon,
  UserCircleIcon,
} from '@hugeicons/core-free-icons'
import type { AccountWire } from '../account.js'
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
    h('p', 'ez-empty-lead', '從左邊選專案，或加入新專案'),
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
  const account = accountFooter(api)
  side.append(top, section, rows, errorLine, updateRow(desktop), account.el)
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
    account.paint(next.account)
    paint()
    if (!performance.getEntriesByName(LIST_SHOWN_MARK).length) performance.mark(LIST_SHOWN_MARK)
  })
  paint()
}

/** The one sign-in every project shares, so it lives with the list rather than in a review. */
function accountFooter(api: string): { el: HTMLElement; paint(account: AccountWire): void } {
  const el = h('div', 'ez-side-account')
  const button = h('button', 'ez-side-open ez-side-account-btn')
  button.type = 'button'
  const menu = h('div', 'ez-menu')
  menu.setAttribute('role', 'menu')
  const who = h('div', 'ez-account-who')
  const signOut = h('button', 'ez-menu-item')
  signOut.type = 'button'
  signOut.setAttribute('role', 'menuitem')
  signOut.append(icon(Logout01Icon as IconNode, 14), h('span', 'ez-menu-name', '登出'))
  menu.append(who, signOut)
  el.append(menu, button)

  let email: string | null | undefined
  const setOpen = (open: boolean) => {
    el.toggleAttribute('data-open', open && !!email)
    if (email) button.setAttribute('aria-expanded', String(el.hasAttribute('data-open')))
  }
  button.onclick = () => (email ? setOpen(!el.hasAttribute('data-open')) : void window.open(`${api}/account/login`, '_blank'))
  signOut.onclick = () => {
    setOpen(false)
    void fetch(`${api}/account/logout`, { method: 'POST', headers: { 'content-type': 'application/json' } })
  }
  document.addEventListener('click', (e) => {
    if (e.target instanceof Node && !el.contains(e.target)) setOpen(false)
  })
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !el.hasAttribute('data-open')) return
    setOpen(false)
    button.focus()
  })

  return {
    el,
    paint(account) {
      if (account.email === email) return
      email = account.email
      setOpen(false)
      if (email) {
        button.setAttribute('aria-haspopup', 'menu')
        button.title = email
        button.replaceChildren(h('span', 'ez-avatar', email.charAt(0).toUpperCase()), h('span', 'ez-side-name', email))
        who.replaceChildren(h('span', 'ez-account-label', '已登入'), h('span', 'ez-account-email', email))
      } else {
        button.removeAttribute('aria-haspopup')
        button.removeAttribute('aria-expanded')
        button.title = '登入 ezdesign'
        button.replaceChildren(icon(UserCircleIcon as IconNode, 15), h('span', 'ez-side-name', '登入'))
      }
    },
  }
}

/** A new version of the app, above the account. Restarting installs it; an app
 *  that cannot replace itself where it is opens the download page instead. */
function updateRow(desktop: DesktopHost): HTMLElement {
  const el = h('div', 'ez-side-update')
  el.hidden = true
  const button = h('button', 'ez-side-open ez-side-update-btn')
  button.type = 'button'
  button.onclick = () => desktop.takeUpdate()
  el.append(button)
  desktop.onUpdate((offer) => {
    el.hidden = !offer
    if (!offer) return
    const restart = offer.by === 'restart'
    button.title = restart ? `重新啟動 ezdesign，換成 ${offer.version}` : `下載 ezdesign ${offer.version}`
    button.replaceChildren(
      icon((restart ? ArrowReloadHorizontalIcon : Download04Icon) as IconNode, 15),
      h('span', 'ez-side-name', restart ? `重新啟動以更新到 ${offer.version}` : `下載新版 ${offer.version}`),
    )
  })
  return el
}
