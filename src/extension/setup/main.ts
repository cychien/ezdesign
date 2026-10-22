import type { HostState, WorkerRequest } from '../shared/messages.js'

const status = document.getElementById('status')!

function check(recheck: boolean): Promise<HostState> {
  const request: WorkerRequest = { to: 'worker', type: 'host-status', recheck }
  return chrome.runtime.sendMessage<HostState>(request)
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { dataset, ...rest } = props
  Object.assign(node, rest)
  if (dataset) Object.assign(node.dataset, dataset)
  node.append(...children)
  return node
}

function heading(text: string, tone: 'ok' | 'bad' | 'idle'): HTMLElement {
  return el('p', { className: 'state', dataset: { tone } }, text)
}

function commandRow(command: string): HTMLElement {
  const copy = el('button', { type: 'button', textContent: '複製' })
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(command).then(() => {
      copy.textContent = '已複製'
      setTimeout(() => (copy.textContent = '複製'), 1500)
    })
  })
  return el('div', { className: 'command' }, el('code', { textContent: command }), copy)
}

function recheckButton(): HTMLElement {
  const button = el('button', { type: 'button', className: 'primary', textContent: '重新檢查' })
  button.addEventListener('click', () => {
    button.disabled = true
    button.textContent = '檢查中…'
    void check(true).then(render)
  })
  return el('div', { className: 'actions' }, button)
}

function render(state: HostState): void {
  switch (state.type) {
    case 'connecting':
      status.replaceChildren(heading('正在檢查 ezdesign host…', 'idle'))
      return
    case 'ready':
      status.replaceChildren(
        heading('已連線', 'ok'),
        el(
          'dl',
          {},
          el('dt', { textContent: 'ezdesign' }),
          el('dd', { textContent: state.version }),
          el('dt', { textContent: 'Node' }),
          el('dd', { textContent: state.node }),
          el('dt', { textContent: '收藏位置' }),
          el('dd', { textContent: state.libraryDir }),
        ),
        el('p', { className: 'how', textContent: '在網頁的圖片或影片上按右鍵，選「儲存至 ezdesign」；按工具列的 ezdesign 圖示或 Alt+Shift+S 截取一塊區域。' }),
      )
      return
    case 'missing':
      status.replaceChildren(
        heading('找不到 ezdesign host', 'bad'),
        el('p', { textContent: '在終端機執行這行指令，裝好後按「重新檢查」。' }),
        commandRow(state.installCommand),
        recheckButton(),
      )
      return
    case 'incompatible':
      status.replaceChildren(
        heading(state.older === 'host' ? 'ezdesign host 版本太舊' : '這個擴充功能版本太舊', 'bad'),
        el('p', { textContent: '在終端機執行這行指令更新，然後按「重新檢查」。' }),
        commandRow(state.installCommand),
        recheckButton(),
      )
      return
    case 'broken':
      status.replaceChildren(
        heading('ezdesign host 無法使用', 'bad'),
        el('p', { className: 'message', textContent: state.message }),
        recheckButton(),
      )
      return
  }
}

render({ type: 'connecting' })
void check(false).then(render)
