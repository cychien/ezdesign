import {
  ArrowReloadHorizontalIcon,
  ComputerTerminal01Icon,
  PlayIcon,
  StopIcon,
} from '@hugeicons/core-free-icons'
import { agentProfileFor } from '../agents.js'
import type { DevCommandWire, DevServerLogWire, DevServerWire, InstallPart, ProposalWire, UndecidedReason } from '../dev-server/wire.js'
import { host } from './host.js'
import { type IconNode, icon } from './icon.js'

export const DEV_SERVER_TEST_IDS = {
  card: 'ez-devserver-card',
  strip: 'ez-devserver-strip',
  log: 'ez-devserver-log',
} as const

export interface DevServerPanel {
  readonly card: HTMLElement
  readonly strip: HTMLElement
  update(state: DevServerWire, page: { shown: boolean; onAppTab: boolean }): void
}

const LOG_POLL_MS = 700
const CARD_LOG_LINES = 200

const REASON: Record<UndecidedReason, string> = {
  'no-package-json': '這個專案沒有 package.json，ezdesign 不知道要怎麼啟動它。',
  'no-script': 'package.json 裡沒有 dev 或 start script。',
  'monorepo-root': '這是 monorepo 的根目錄，請指定要啟動哪一個 app。',
}

const SOURCE: Record<DevCommandWire['source'], string> = {
  detected: '從 package.json 偵測',
  agent: 'agent 建議、你確認過的指令',
  user: '你設定的指令',
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, label: string, glyph?: IconNode): HTMLButtonElement {
  const b = h('button', className)
  b.type = 'button'
  if (glyph) b.append(icon(glyph, 14))
  b.append(h('span', undefined, label))
  return b
}

function iconButton(glyph: IconNode, label: string): HTMLButtonElement {
  const b = h('button', 'ez-devserver-icon')
  b.type = 'button'
  b.title = label
  b.setAttribute('aria-label', label)
  b.append(icon(glyph, 14))
  return b
}

function installLine(parts: readonly InstallPart[]): HTMLElement {
  const span = h('span')
  for (const part of parts) span.append('command' in part ? h('code', 'ez-devserver-inline', part.command) : part.text)
  return span
}

const agentName = (command: string) => agentProfileFor(command)?.name ?? 'agent'

function crashLine(state: Extract<DevServerWire, { phase: 'crashed' }>): string {
  if (state.cause === 'no-url') return '60 秒內沒有印出網址，也沒有開啟任何 port，已停止它。'
  if (state.cause === 'spawn') return '指令沒辦法執行。'
  if (state.signal) return `Dev server 被 ${state.signal} 結束了。`
  return state.exitCode !== undefined ? `Dev server 結束了（exit code ${state.exitCode}）。` : 'Dev server 結束了。'
}

export function installDevServerPanel(api: string, opts: { openCanvas(): void }): DevServerPanel {
  const card = h('section', 'ez-devserver-card')
  card.dataset.testid = DEV_SERVER_TEST_IDS.card
  card.setAttribute('aria-live', 'polite')
  card.hidden = true
  const strip = h('div', 'ez-devserver-strip')
  strip.dataset.testid = DEV_SERVER_TEST_IDS.strip
  strip.hidden = true

  let state: DevServerWire | null = null
  let drawnFor = ''
  let editing = false
  let error: string | null = null
  let busy = false
  const log = new LogFeed(api)

  async function post(path: string, body: Record<string, unknown> = {}, method = 'POST'): Promise<boolean> {
    busy = true
    error = null
    repaint()
    try {
      const res = await fetch(`${api}/dev-server/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, host: host.kind }),
      })
      if (!res.ok) error = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${res.status}`
      return res.ok
    } catch {
      error = '連不上 ezdesign daemon'
      return false
    } finally {
      busy = false
      repaint()
    }
  }

  function repaint(): void {
    drawnFor = ''
    if (state) paint(state, lastPage)
  }

  function commandBlock(command: DevCommandWire): HTMLElement {
    const block = h('div', 'ez-devserver-command')
    const line = h('code', 'ez-devserver-line', command.line)
    block.append(line)
    const where = command.cwd ? `${SOURCE[command.source]} · 在 ${command.cwd}/ 執行` : SOURCE[command.source]
    block.append(h('span', 'ez-devserver-source', where))
    return block
  }

  function commandForm(initial: DevCommandWire | undefined, cancellable: boolean, proposalId?: string): HTMLFormElement {
    const form = h('form', 'ez-devserver-form')
    const lineLabel = h('label', 'ez-devserver-label', '啟動指令')
    const lineInput = h('input', 'ez-devserver-input')
    lineInput.name = 'line'
    lineInput.placeholder = 'pnpm --filter web dev'
    lineInput.value = initial?.line ?? ''
    lineInput.spellcheck = false
    lineInput.autocomplete = 'off'
    lineLabel.append(lineInput)
    const cwdLabel = h('label', 'ez-devserver-label', '在哪個資料夾執行（相對於專案，選填）')
    const cwdInput = h('input', 'ez-devserver-input')
    cwdInput.name = 'cwd'
    cwdInput.placeholder = '.'
    cwdInput.value = initial?.cwd ?? ''
    cwdInput.spellcheck = false
    cwdInput.autocomplete = 'off'
    cwdLabel.append(cwdInput)
    const actions = h('div', 'ez-devserver-actions')
    const go = button('ez-devserver-go', '儲存並啟動', PlayIcon as IconNode)
    go.type = 'submit'
    go.disabled = busy
    actions.append(go)
    if (cancellable) {
      const cancel = button('ez-devserver-secondary', '取消')
      cancel.onclick = () => {
        editing = false
        error = null
        repaint()
      }
      actions.append(cancel)
    }
    if (initial?.source === 'user' || initial?.source === 'agent') {
      const reset = button('ez-devserver-secondary', '改回自動偵測')
      reset.onclick = () => {
        editing = false
        void post('command', {}, 'DELETE')
      }
      actions.append(reset)
    }
    form.append(lineLabel, cwdLabel, actions)
    form.onsubmit = (e) => {
      e.preventDefault()
      void post('command', { line: lineInput.value, cwd: cwdInput.value, ...(proposalId ? { proposalId } : {}) }).then((ok) => {
        if (ok) editing = false
        repaint()
      })
    }
    queueMicrotask(() => lineInput.focus({ preventScroll: true }))
    return form
  }

  function canvasOnly(): HTMLButtonElement {
    const b = button('ez-devserver-secondary', '只用 canvas')
    b.onclick = () => opts.openCanvas()
    return b
  }

  function proposalBlock(offer: Extract<ProposalWire, { state: 'proposed' }>): HTMLElement {
    const block = commandBlock({ line: offer.line, cwd: offer.cwd, source: 'agent' })
    block.querySelector('.ez-devserver-source')!.textContent = `${agentName(offer.agent)} 的建議${offer.cwd ? ` · 在 ${offer.cwd}/ 執行` : ''}`
    if (offer.reason) block.append(h('span', 'ez-devserver-reason', offer.reason))
    return block
  }

  function proposalNote(offer: ProposalWire): HTMLElement {
    const name = agentName(offer.agent)
    switch (offer.state) {
      case 'asking':
        return h('p', 'ez-devserver-asking', `正在請 ${name} 看看這個專案…`)
      case 'none-found':
        return h('p', 'ez-devserver-hint', `${name} 看過了，沒找到可以啟動的網頁${offer.reason ? `：${offer.reason}` : '。'}`)
      case 'failed':
        return h('p', 'ez-devserver-error', `沒辦法取得 ${name} 的建議：${offer.error}`)
      case 'proposed':
        return h('p', 'ez-devserver-hint', `${name} 建議的指令，可以先修改再執行。`)
    }
  }

  function logBlock(lines: number): HTMLElement {
    const pre = h('pre', 'ez-devserver-log')
    pre.dataset.testid = DEV_SERVER_TEST_IDS.log
    pre.tabIndex = 0
    log.into(pre, lines)
    return pre
  }

  function paintCard(s: DevServerWire): void {
    const title = h('h2', 'ez-devserver-title')
    const body: HTMLElement[] = []
    const actions = h('div', 'ez-devserver-actions')
    const start = (label: string) => {
      const b = button('ez-devserver-go', label, PlayIcon as IconNode)
      b.disabled = busy
      b.onclick = () => void post(s.phase === 'crashed' ? 'restart' : 'start')
      actions.append(b)
    }
    const edit = (label = '改用其他指令') => {
      const b = button('ez-devserver-secondary', label)
      b.onclick = () => {
        editing = true
        repaint()
      }
      actions.append(b)
    }
    const command = 'command' in s ? s.command : undefined

    if (editing && s.phase !== 'starting' && s.phase !== 'needs-command') {
      title.textContent = 'Dev server 的啟動指令'
      body.push(h('p', 'ez-devserver-text', '指令會在專案資料夾裡用 shell 執行，之後每次都用它啟動。'), commandForm(command, true))
    } else {
      switch (s.phase) {
        case 'idle':
        case 'stopped':
          title.textContent = s.phase === 'idle' ? '啟動 dev server' : 'Dev server 已停止'
          if (command) {
            body.push(h('p', 'ez-devserver-text', '在 App 分頁標註之前，先把專案跑起來。'), commandBlock(command))
            start('啟動')
            edit()
          } else {
            body.push(h('p', 'ez-devserver-text', 'ezdesign 判斷不出啟動指令，會請 agent 看看這個專案，你確認之後才會執行。'))
            start('啟動')
            edit('自己輸入指令')
          }
          break
        case 'starting': {
          title.textContent = '正在啟動 dev server'
          if (command) body.push(commandBlock(command))
          body.push(logBlock(CARD_LOG_LINES))
          const stop = button('ez-devserver-secondary', '停止', StopIcon as IconNode)
          stop.disabled = busy
          stop.onclick = () => void post('stop')
          actions.append(stop)
          break
        }
        case 'needs-command': {
          title.textContent = '需要一個啟動指令'
          body.push(h('p', 'ez-devserver-text', REASON[s.reason]))
          const offer = s.proposal
          if (offer?.state === 'proposed' && !editing) {
            body.push(proposalBlock(offer))
            const run = button('ez-devserver-go', '執行', PlayIcon as IconNode)
            run.disabled = busy
            run.onclick = () => void post('command', { line: offer.line, cwd: offer.cwd, proposalId: offer.id })
            const change = button('ez-devserver-secondary', '修改')
            change.onclick = () => {
              editing = true
              repaint()
            }
            actions.append(run, change)
            break
          }
          if (offer) body.push(proposalNote(offer))
          if (s.serverScripts.length) body.push(h('p', 'ez-devserver-hint', `看起來像 dev server 的 script：${s.serverScripts.join('、')}`))
          body.push(
            offer?.state === 'proposed'
              ? commandForm({ line: offer.line, cwd: offer.cwd, source: 'agent' }, true, offer.id)
              : commandForm(undefined, false),
          )
          if (offer?.state === 'failed' || offer?.state === 'none-found') {
            const again = button('ez-devserver-secondary', '再問一次')
            again.onclick = () => void post('propose')
            actions.append(again)
          }
          break
        }
        case 'blocked': {
          title.textContent = '缺少啟動需要的工具'
          body.push(commandBlock(s.command))
          const list = h('ul', 'ez-devserver-missing')
          for (const m of s.missing) {
            const item = h('li')
            item.append(h('code', 'ez-devserver-tool', m.tool), installLine(m.install))
            list.append(item)
          }
          body.push(list, h('p', 'ez-devserver-hint', '裝好之後按「再試一次」。'))
          start('再試一次')
          edit()
          break
        }
        case 'crashed':
          title.textContent = 'Dev server 停止運作了'
          body.push(h('p', 'ez-devserver-text', crashLine(s)), commandBlock(s.command))
          if (s.tail.length) {
            const pre = h('pre', 'ez-devserver-log', s.tail.join('\n'))
            pre.dataset.testid = DEV_SERVER_TEST_IDS.log
            pre.tabIndex = 0
            body.push(pre)
            queueMicrotask(() => (pre.scrollTop = pre.scrollHeight))
          }
          start('重新啟動')
          edit()
          break
        case 'running':
        case 'external':
          title.textContent = '正在連上 dev server'
          break
      }
    }
    if (!editing && s.phase !== 'running' && s.phase !== 'external') actions.append(canvasOnly())
    card.replaceChildren(title, ...body)
    if (actions.childElementCount) card.append(actions)
    if (error) card.append(h('p', 'ez-devserver-error', error))
  }

  function paintStrip(s: DevServerWire): void {
    const dot = h('span', 'ez-devserver-dot')
    dot.dataset.phase = s.phase
    const parts: HTMLElement[] = [dot]
    if (s.phase === 'external') {
      parts.push(h('span', 'ez-devserver-name', '你自己啟動的 dev server'))
      strip.replaceChildren(...parts)
      return
    }
    const command = 'command' in s ? s.command : undefined
    const name = h('code', 'ez-devserver-name', command?.line ?? 'dev server')
    name.title = s.phase === 'starting' ? '重新啟動中' : (command?.line ?? '')
    parts.push(name)
    if (s.phase === 'running' && s.origins.length > 1) {
      const pick = h('select', 'ez-devserver-origin')
      pick.setAttribute('aria-label', '要顯示的網址')
      for (const origin of s.origins) {
        const option = h('option', undefined, origin.replace(/^https?:\/\//, ''))
        option.value = origin
        option.selected = origin === s.origin
        pick.append(option)
      }
      pick.onchange = () => void post('origin', { origin: pick.value })
      parts.push(pick)
    }
    const showLog = iconButton(ComputerTerminal01Icon as IconNode, 'Dev server 的 log')
    showLog.onclick = () => openLogDialog(log)
    const restart = iconButton(ArrowReloadHorizontalIcon as IconNode, '重新啟動 dev server')
    restart.disabled = busy || s.phase === 'starting'
    restart.onclick = () => void post('restart')
    const stop = iconButton(StopIcon as IconNode, '停止 dev server')
    stop.disabled = busy
    stop.onclick = () => void post('stop')
    parts.push(showLog, restart, stop)
    strip.replaceChildren(...parts)
  }

  let lastPage = { shown: false, onAppTab: false }

  function paint(s: DevServerWire, page: { shown: boolean; onAppTab: boolean }): void {
    const showCard = page.onAppTab && !page.shown
    const showStrip = page.onAppTab && page.shown && (s.phase === 'running' || s.phase === 'external' || s.phase === 'starting')
    card.hidden = !showCard
    strip.hidden = !showStrip
    log.feedCard(showCard && s.phase === 'starting')
    const key = JSON.stringify([s, showCard, showStrip, editing, busy, error])
    if (key === drawnFor) return
    drawnFor = key
    if (showCard) paintCard(s)
    if (showStrip) paintStrip(s)
  }

  return {
    card,
    strip,
    update(next, page) {
      if (next.phase === 'starting' && state?.phase !== 'starting') log.reset()
      state = next
      lastPage = page
      paint(next, page)
    },
  }
}

class LogFeed {
  private timer: number | null = null
  private views = new Set<{ pre: HTMLElement; lines: number }>()
  private last: DevServerLogWire = { lines: [], dropped: 0 }
  private wanted = false

  constructor(private readonly api: string) {}

  into(pre: HTMLElement, lines: number): void {
    const view = { pre, lines }
    this.views.add(view)
    this.draw(view)
    this.schedule()
    void this.fetch()
  }

  detach(pre: HTMLElement): void {
    for (const view of this.views) if (view.pre === pre) this.views.delete(view)
    this.schedule()
  }

  reset(): void {
    this.last = { lines: [], dropped: 0 }
  }

  feedCard(on: boolean): void {
    this.wanted = on
    for (const view of [...this.views]) if (!view.pre.isConnected) this.views.delete(view)
    this.schedule()
  }

  private schedule(): void {
    const needed = this.wanted || [...this.views].some((v) => v.pre.closest('dialog[open]'))
    if (needed && this.timer === null) {
      this.timer = window.setInterval(() => void this.fetch(), LOG_POLL_MS)
    } else if (!needed && this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  private async fetch(): Promise<void> {
    try {
      const res = await fetch(`${this.api}/dev-server/log`)
      if (!res.ok) return
      this.last = (await res.json()) as DevServerLogWire
    } catch {
      return
    }
    for (const view of this.views) this.draw(view)
  }

  private draw(view: { pre: HTMLElement; lines: number }): void {
    const { pre } = view
    const pinned = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24
    const text = this.last.lines.slice(-view.lines).join('\n')
    if (pre.textContent === text) return
    pre.textContent = text
    if (pinned) pre.scrollTop = pre.scrollHeight
  }
}

function openLogDialog(log: LogFeed): void {
  const dialog = h('dialog', 'ez-dialog ez-devserver-dialog')
  const head = h('div', 'ez-devserver-dialog-head')
  const title = h('h2', 'ez-dialog-title', 'Dev server 的 log')
  title.id = 'ez-devserver-log-title'
  const close = h('button', 'ez-dialog-cancel', '關閉')
  close.type = 'button'
  head.append(title, close)
  const pre = h('pre', 'ez-devserver-log ez-devserver-log-full')
  pre.dataset.testid = DEV_SERVER_TEST_IDS.log
  pre.tabIndex = 0
  dialog.append(head, pre)
  dialog.setAttribute('aria-labelledby', title.id)
  document.body.append(dialog)
  const done = () => {
    dialog.close()
    dialog.remove()
    log.detach(pre)
  }
  close.onclick = done
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault()
    done()
  })
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) done()
  })
  dialog.addEventListener('keydown', (e) => e.stopPropagation())
  dialog.showModal()
  close.focus()
  log.into(pre, Infinity)
}
