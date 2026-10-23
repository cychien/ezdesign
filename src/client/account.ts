import Logout01Icon from '@hugeicons/core-free-icons/Logout01Icon'
import UserCircleIcon from '@hugeicons/core-free-icons/UserCircleIcon'
import { type IconNode, icon } from './icon.js'

export interface AccountWire {
  email: string
}

export interface AccountUi {
  readonly el: HTMLElement
  render(account: AccountWire | undefined): void
  signedInOrPrompt(): boolean
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

export function installAccount(apiBase: string): AccountUi {
  let account: AccountWire | undefined
  let painted = false
  let open = false

  const el = h('div', 'ez-account')
  const button = h('button', 'ez-activity-btn ez-account-btn')
  button.type = 'button'
  const menu = h('div', 'ez-menu ez-account-menu')
  menu.setAttribute('role', 'menu')
  const who = h('div', 'ez-account-who')
  const signOut = h('button', 'ez-menu-item')
  signOut.type = 'button'
  signOut.setAttribute('role', 'menuitem')
  signOut.append(icon(Logout01Icon as IconNode, 14), h('span', 'ez-menu-name', '登出'))
  menu.append(who, signOut)
  el.append(button, menu)

  const signIn = () => window.open(`${apiBase}/account/login`, '_blank')

  function setOpen(next: boolean): void {
    open = next && !!account
    el.toggleAttribute('data-open', open)
    if (account) button.setAttribute('aria-expanded', String(open))
    else button.removeAttribute('aria-expanded')
  }

  function render(next: AccountWire | undefined): void {
    if (painted && account?.email === next?.email) return
    painted = true
    account = next
    button.textContent = ''
    if (account) {
      const name = `帳號：${account.email}`
      button.setAttribute('aria-label', name)
      button.title = account.email
      button.setAttribute('aria-haspopup', 'menu')
      button.append(h('span', 'ez-avatar', account.email.charAt(0).toUpperCase()))
      who.replaceChildren(h('span', 'ez-account-label', '已登入'), h('span', 'ez-account-email', account.email))
    } else {
      button.setAttribute('aria-label', '登入 ezdesign')
      button.title = '登入 ezdesign'
      button.removeAttribute('aria-haspopup')
      button.append(icon(UserCircleIcon as IconNode, 18))
    }
    setOpen(false)
  }

  button.onclick = () => {
    if (account) setOpen(!open)
    else signIn()
  }

  signOut.onclick = async () => {
    setOpen(false)
    await fetch(`${apiBase}/account/logout`, { method: 'POST', headers: { 'content-type': 'application/json' } })
  }

  document.addEventListener('click', (e) => {
    if (open && e.target instanceof Node && !el.contains(e.target)) setOpen(false)
  })
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      setOpen(false)
      button.focus()
    }
  })

  render(undefined)
  return {
    el,
    render,
    signedInOrPrompt: () => {
      if (account) return true
      signIn()
      return false
    },
  }
}
