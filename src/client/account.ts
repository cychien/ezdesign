import Logout01Icon from '@hugeicons/core-free-icons/Logout01Icon'
import UserCircleIcon from '@hugeicons/core-free-icons/UserCircleIcon'
import { type IconNode, icon } from './icon.js'

export interface AccountWire {
  email: string | null
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
  let offered = false
  let email: string | null = null
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
    open = next && !!email
    el.toggleAttribute('data-open', open)
    if (email) button.setAttribute('aria-expanded', String(open))
    else button.removeAttribute('aria-expanded')
  }

  function render(account: AccountWire | undefined): void {
    const nextEmail = account?.email ?? null
    if (painted && offered === !!account && email === nextEmail) return
    painted = true
    offered = !!account
    email = nextEmail
    el.hidden = !offered
    button.textContent = ''
    if (email) {
      button.setAttribute('aria-label', `帳號：${email}`)
      button.title = email
      button.setAttribute('aria-haspopup', 'menu')
      button.append(h('span', 'ez-avatar', email.charAt(0).toUpperCase()))
      who.replaceChildren(h('span', 'ez-account-label', '已登入'), h('span', 'ez-account-email', email))
    } else {
      button.setAttribute('aria-label', '登入 ezdesign')
      button.title = '登入 ezdesign'
      button.removeAttribute('aria-haspopup')
      button.append(icon(UserCircleIcon as IconNode, 18))
    }
    setOpen(false)
  }

  button.onclick = () => {
    if (email) setOpen(!open)
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
      if (email) return true
      if (offered) signIn()
      return false
    },
  }
}
