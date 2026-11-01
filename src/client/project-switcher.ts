import { ArrowDown01Icon, Folder01Icon, GridViewIcon } from '@hugeicons/core-free-icons'
import type { ProjectListWire } from '../projects/wire.js'
import { host } from './host.js'
import { type IconNode, icon } from './icon.js'
import { devServerStatus, projectsClient } from './projects.js'

export const SWITCHER_TEST_IDS = { button: 'ez-project-switcher', menu: 'ez-project-menu' } as const

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

export function installProjectSwitcher(api: string, version: string, project: string): HTMLElement {
  const client = projectsClient(api, version)
  const wrap = h('div', 'ez-switcher')
  const button = h('button', 'ez-switcher-button')
  button.type = 'button'
  button.dataset.testid = SWITCHER_TEST_IDS.button
  button.setAttribute('aria-haspopup', 'menu')
  button.setAttribute('aria-expanded', 'false')
  button.title = `${project}（切換專案）`
  button.append(icon(Folder01Icon as IconNode, 14), h('span', 'ez-switcher-name', basename(project)), icon(ArrowDown01Icon as IconNode, 12))
  const menu = h('div', 'ez-menu ez-switcher-menu')
  menu.dataset.testid = SWITCHER_TEST_IDS.menu
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', '切換專案')
  wrap.append(button, menu)

  const setOpen = (open: boolean) => {
    wrap.toggleAttribute('data-open', open)
    button.setAttribute('aria-expanded', String(open))
  }

  function paint(list: ProjectListWire | null, error?: string): void {
    const items: HTMLElement[] = []
    for (const row of list?.projects ?? []) {
      if (row.project === project) continue
      const item = h('button', 'ez-menu-item ez-switcher-item')
      item.setAttribute('role', 'menuitem')
      item.title = row.project
      item.disabled = !row.exists
      const status = devServerStatus(row)
      const dot = h('span', 'ez-switcher-dot')
      if (status) dot.dataset.phase = status.phase
      item.append(dot, h('span', 'ez-menu-name', row.name))
      if (!row.exists) item.append(h('span', 'ez-switcher-note', '資料夾不見了'))
      item.onclick = () => {
        setOpen(false)
        void client.go(row.project).catch((e: Error) => {
          setOpen(true)
          paint(list, e.message)
        })
      }
      items.push(item)
    }
    if (list && !items.length) items.push(h('div', 'ez-switcher-empty', '沒有其他專案'))
    if (!list && !error) items.push(h('div', 'ez-switcher-empty', '載入中…'))
    if (error) items.push(h('div', 'ez-switcher-error', error))
    const all = h('button', 'ez-menu-item ez-switcher-all')
    all.append(icon(GridViewIcon as IconNode, 14), h('span', 'ez-menu-name', '所有專案'))
    all.setAttribute('role', 'menuitem')
    all.disabled = !list
    all.onclick = () => {
      setOpen(false)
      if (list) host.showHome(list.home)
    }
    menu.replaceChildren(...items, h('div', 'ez-switcher-sep'), all)
  }

  button.onclick = () => {
    const open = !wrap.hasAttribute('data-open')
    setOpen(open)
    if (!open) return
    paint(null)
    client.list().then(
      (list) => paint(list),
      (e: Error) => paint(null, e.message),
    )
  }
  document.addEventListener('click', (e) => {
    if (e.target instanceof Node && !wrap.contains(e.target)) setOpen(false)
  })
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !wrap.hasAttribute('data-open')) return
    e.stopPropagation()
    setOpen(false)
    button.focus()
  })
  return wrap
}
