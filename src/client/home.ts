import { Cancel01Icon, Folder01Icon, StopIcon } from '@hugeicons/core-free-icons'
import { brandLockupSvg } from '../brand.js'
import type { ProjectListWire, ProjectWire } from '../projects/wire.js'
import { host } from './host.js'
import { type IconNode, icon } from './icon.js'
import { devServerStatus, projectsClient } from './projects.js'

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

  const form = h('form', 'ez-home-add')
  form.dataset.testid = HOME_TEST_IDS.add
  const input = h('input', 'ez-home-input')
  input.name = 'path'
  input.placeholder = '/Users/you/code/my-app'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.setAttribute('aria-label', '專案資料夾的完整路徑')
  const add = h('button', 'ez-home-add-go', '加入專案')
  add.type = 'submit'
  form.append(input, add)
  form.onsubmit = (e) => {
    e.preventDefault()
    const path = input.value.trim()
    if (!path) return input.focus()
    add.disabled = true
    client.add(path).then(
      () => {
        input.value = ''
        error = null
        paint()
      },
      (e: Error) => {
        error = e.message
        paint()
      },
    ).finally(() => (add.disabled = false))
  }

  const errorLine = h('p', 'ez-home-error')
  errorLine.setAttribute('role', 'alert')
  const rows = h('ul', 'ez-home-list')
  rows.dataset.testid = HOME_TEST_IDS.list
  rows.setAttribute('aria-label', '專案')
  page.append(head, title, lead, form, errorLine, rows)
  root.replaceChildren(page)

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
    open.onclick = () => {
      opening = project.project
      error = null
      paint()
      client.go(project.project).catch((e: Error) => {
        opening = null
        error = e.message
        paint()
      })
    }
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
        h('span', undefined, '在上面貼上專案資料夾的路徑，或在專案資料夾裡執行 npx -y @cychien/ezdesign。'),
      )
      rows.replaceChildren(empty)
      return
    }
    rows.replaceChildren(...list.projects.map((p) => row(p, now)))
  }

  client.watch((next) => {
    list = next
    paint()
  })
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return
    opening = null
    paint()
  })
  paint()
}
