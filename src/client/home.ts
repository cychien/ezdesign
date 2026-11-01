import { Cancel01Icon, Folder01Icon, FolderAddIcon, StopIcon } from '@hugeicons/core-free-icons'
import { brandLockupSvg } from '../brand.js'
import type { ProjectListWire, ProjectWire } from '../projects/wire.js'
import { host } from './host.js'
import { type IconNode, icon } from './icon.js'
import { devServerStatus, projectsClient } from './projects.js'

export const LIST_SHOWN_MARK = 'ez:list-shown'

export const HOME_TEST_IDS = {
  list: 'ez-home-list',
  row: 'ez-home-row',
  add: 'ez-home-add',
} as const

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const RELATIVE = new Intl.RelativeTimeFormat('zh-TW', { numeric: 'auto' })
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['minute', 60],
  ['hour', 60],
  ['day', 24],
  ['week', 7],
  ['month', 4.35],
  ['year', 12],
]

function ago(at: number, now: number): string {
  let value = (at - now) / 60_000
  if (Math.abs(value) < 1) return '剛剛'
  for (const [unit, next] of STEPS) {
    if (Math.abs(value) < next || unit === 'year') return RELATIVE.format(Math.round(value), unit)
    value /= next
  }
  return ''
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

export function bootHome(root: HTMLElement, api: string, version: string): void {
  if (host.kind !== 'desktop') return void root.replaceChildren(appOnlyNote())
  const desktop = host
  const client = projectsClient(api, version)
  let list: ProjectListWire | null = null
  let opening: string | null = null
  let error: string | null = null

  const page = h('main', 'ez-home')
  const head = h('header', 'ez-home-head')
  const brand = h('div', 'ez-logo')
  brand.setAttribute('role', 'img')
  brand.setAttribute('aria-label', 'ezdesign')
  brand.innerHTML = brandLockupSvg()
  head.append(brand)

  const title = h('h1', 'ez-home-title', '專案')
  const lead = h('p', 'ez-home-lead', '選一個專案開始設計，ezdesign 會幫你把它的 dev server 跑起來。')

  const add = h('div', 'ez-home-add')
  add.dataset.testid = HOME_TEST_IDS.add
  const pick = h('button', 'ez-home-add-go ez-home-pick')
  pick.type = 'button'
  pick.append(icon(FolderAddIcon as IconNode, 16), h('span', undefined, '加入資料夾…'))
  pick.onclick = () => void desktop.pickFolder().then((path) => path && addAndOpen(path))
  add.append(pick, h('span', 'ez-home-hint', '或把專案資料夾拖進這個視窗'))

  function addAndOpen(path: string): void {
    client.add(path).then(
      (added) => openProject(added.project),
      (e: Error) => {
        error = e.message
        paint()
      },
    )
  }

  document.addEventListener('dragover', (e) => {
    e.preventDefault()
    page.toggleAttribute('data-dragging', true)
  })
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) page.toggleAttribute('data-dragging', false)
  })
  document.addEventListener('drop', (e) => {
    e.preventDefault()
    page.toggleAttribute('data-dragging', false)
    const file = e.dataTransfer?.files[0]
    const path = file ? desktop.pathForFile(file) : ''
    if (path) addAndOpen(path)
  })

  const errorLine = h('p', 'ez-home-error')
  errorLine.setAttribute('role', 'alert')
  const rows = h('ul', 'ez-home-list')
  rows.dataset.testid = HOME_TEST_IDS.list
  rows.setAttribute('aria-label', '專案')
  page.append(head, title, lead, add, errorLine, rows)
  root.replaceChildren(page)

  function openProject(project: string): void {
    opening = project
    error = null
    paint()
    client
      .go(project)
      .catch((e: Error) => (error = e.message))
      .finally(() => {
        opening = null
        paint()
      })
  }

  function row(project: ProjectWire, now: number): HTMLElement {
    const item = h('li', 'ez-home-row')
    item.dataset.testid = HOME_TEST_IDS.row
    item.toggleAttribute('data-missing', !project.exists)
    const open = h('button', 'ez-home-open')
    open.type = 'button'
    open.disabled = !project.exists || opening !== null
    open.title = project.exists ? `開啟 ${project.name}` : '這個資料夾已經不在了'
    const text = h('span', 'ez-home-text')
    text.append(h('span', 'ez-home-name', project.name), h('span', 'ez-home-path', `\u200e${project.project}\u200e`))
    const status = devServerStatus(project)
    const meta = h('span', 'ez-home-meta')
    if (opening === project.project) meta.append(h('span', 'ez-home-status', '開啟中…'))
    else if (!project.exists) meta.append(h('span', 'ez-home-status', '資料夾不見了'))
    else if (status) {
      const pill = h('span', 'ez-home-status')
      pill.dataset.phase = status.phase
      pill.append(h('span', 'ez-home-dot'), status.text)
      meta.append(pill)
    } else if (project.usedAt) meta.append(h('span', 'ez-home-when', ago(project.usedAt, now)))
    open.append(icon(Folder01Icon as IconNode, 18), text, meta)
    open.onclick = () => openProject(project.project)
    item.append(open)

    const actions = h('span', 'ez-home-actions')
    if (status && (status.phase === 'running' || status.phase === 'starting')) {
      const stop = h('button', 'ez-home-icon')
      stop.type = 'button'
      stop.title = `停止 ${project.name} 的 dev server`
      stop.setAttribute('aria-label', stop.title)
      stop.append(icon(StopIcon as IconNode, 14))
      stop.onclick = () => void client.stop(project.project).catch((e: Error) => ((error = e.message), paint()))
      actions.append(stop)
    }
    const hide = h('button', 'ez-home-icon')
    hide.type = 'button'
    hide.title = `從清單移除 ${project.name}（資料夾和 .ezdesign 都會保留）`
    hide.setAttribute('aria-label', hide.title)
    hide.append(icon(Cancel01Icon as IconNode, 14))
    hide.onclick = () => void client.hide(project.project).catch((e: Error) => ((error = e.message), paint()))
    actions.append(hide)
    item.append(actions)
    return item
  }

  function paint(): void {
    errorLine.textContent = error ?? ''
    errorLine.hidden = !error
    if (!list) return
    const now = Date.now()
    if (!list.projects.length) {
      const empty = h('li', 'ez-home-empty')
      empty.append(
        h('strong', undefined, '還沒有專案'),
        h('span', undefined, '按「加入資料夾…」或把專案資料夾拖進這個視窗。'),
      )
      rows.replaceChildren(empty)
      return
    }
    rows.replaceChildren(...list.projects.map((p) => row(p, now)))
  }

  client.watch((next) => {
    list = next
    paint()
    if (!performance.getEntriesByName(LIST_SHOWN_MARK).length) performance.mark(LIST_SHOWN_MARK)
  })
  paint()
}
