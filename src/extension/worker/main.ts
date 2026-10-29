/** Listeners are registered synchronously at the top level, as MV3 requires
 *  for a worker that Chrome restarts to deliver an event. */

import type { CaptureId, HostState, PageCommand, PageReplies, WorkerRequest } from '../shared/messages.js'
import { DIALOG_PORT_PREFIX } from '../shared/messages.js'
import type { TabRef } from '../shared/plan.js'
import { type CaptureSeam, SEAM_GLOBAL, type SeamClickData, type SeamTab } from '../shared/seam.js'
import { createCaptures } from './capture.js'
import { createHostLink, extensionVersion } from './host-link.js'
import { MEDIA_DOCUMENT, createMediaClient } from './media.js'
import { TARGET_ATTR, originalOfTarget } from '../page/originals.js'
import { createStreamObserver } from './streams.js'
import type { BrowserOps, DialogPort, PageAgent } from './ports.js'

export const MENU_ID = 'ez-save'
export const REGION_COMMAND = 'capture-region'

function asset(name: string): string {
  const worker = chrome.runtime.getManifest().background?.service_worker ?? ''
  return `${worker.slice(0, worker.lastIndexOf('/') + 1)}${name}`
}

const host = createHostLink()
const media = createMediaClient(asset(MEDIA_DOCUMENT))

const page: PageAgent = {
  async ensure(tab, frameId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: [asset('page.js')] })
      return true
    } catch {
      return false
    }
  },
  async send<C extends PageCommand>(tab: TabRef, frameId: number, command: C) {
    const reply = await chrome.tabs.sendMessage<PageReplies[C['type']] | { error: string } | undefined>(tab.id, command, {
      frameId,
    })
    if (!reply || 'error' in reply) {
      throw new Error(`the page did not answer ${command.type}${reply ? `: ${reply.error}` : ''}`)
    }
    return reply as PageReplies[C['type']]
  },
  async originalOf(tab, frameId) {
    const [run] = await chrome.scripting
      .executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, world: 'MAIN', func: originalOfTarget, args: [TARGET_ATTR] })
      .catch(() => [])
    return typeof run?.result === 'string' ? run.result : null
  },
}

const streams = createStreamObserver()

const DIALOG_WINDOW = { width: 480, height: 640 }

const browser: BrowserOps = {
  captureVisibleTab: (windowId, format) => chrome.tabs.captureVisibleTab(windowId, { format }),
  dialogPath: (captureId) => `${asset('dialog.html')}#${captureId}`,
  openDialogWindow: async (captureId) => {
    const url = chrome.runtime.getURL(`${asset('dialog.html')}#${captureId}`)
    return (await chrome.windows.create({ url, type: 'popup', ...DIALOG_WINDOW, focused: true })).id ?? -1
  },
  closeWindow: (windowId) => chrome.windows.remove(windowId),
  async fetchWithCookies(url, signal) {
    const response = await fetch(url, { credentials: 'include', signal })
    if (!response.ok) throw new Error(`the source answered ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  },
  async fetchPublic(url, signal) {
    const response = await fetch(url, { credentials: 'omit', signal })
    if (!response.ok) throw new Error(`the source answered ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  },
  userAgent: navigator.userAgent,
  now: () => performance.timeOrigin + performance.now(),
}

const RELOADED_FOR = 'reloadedForHostVersion'

const captures = createCaptures({
  host,
  media,
  page,
  browser,
  streams,
  newId: () => crypto.randomUUID().replace(/-/g, '') as CaptureId,
  onIdle: () => void host.state().then(reloadWhenStale),
})

async function reloadWhenStale(state: HostState): Promise<void> {
  if (state.type !== 'ready' || state.version === extensionVersion() || captures.busy()) return
  const stored = await chrome.storage.local.get(RELOADED_FOR)
  if (stored[RELOADED_FOR] === state.version) return
  await chrome.storage.local.set({ [RELOADED_FOR]: state.version })
  chrome.runtime.reload()
}

function hostState(options?: { recheck?: boolean }): Promise<HostState> {
  return host.state(options).then((state) => {
    void reloadWhenStale(state)
    return state
  })
}

const tabRef = (tab: SeamTab): TabRef | null =>
  tab.id === undefined ? null : { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title }

const listeners: CaptureSeam['listeners'] = {
  async contextMenuClicked(info: SeamClickData, tab?: SeamTab) {
    const ref = tab && tabRef(tab)
    if (info.menuItemId !== MENU_ID || !ref) return null
    return captures.start({ type: 'menu', click: info, tab: ref })
  },
  async actionClicked(tab: SeamTab) {
    const ref = tabRef(tab)
    return ref ? captures.start({ type: 'region', tab: ref }) : null
  },
  async command(command: string, tab?: SeamTab) {
    const ref = tab && tabRef(tab)
    if (command !== REGION_COMMAND || !ref) return null
    return captures.start({ type: 'region', tab: ref })
  },
}

chrome.contextMenus.onClicked.addListener(listeners.contextMenuClicked)
chrome.action.onClicked.addListener(listeners.actionClicked)
chrome.commands.onCommand.addListener(listeners.command)

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void chrome.contextMenus
    .removeAll()
    .then(() => chrome.contextMenus.create({ id: MENU_ID, title: '儲存至 ezdesign', contexts: ['image', 'video'] }))
  if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL(asset('setup.html')) })
})

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender?.url ? new URL(port.sender.url) : null
  const fromDialog = port.sender?.id === chrome.runtime.id && sender?.pathname === `/${asset('dialog.html')}`
  if (!port.name.startsWith(DIALOG_PORT_PREFIX) || !fromDialog) {
    port.disconnect()
    return
  }
  captures.attachDialog(port as unknown as DialogPort)
})

chrome.tabs.onRemoved.addListener((tabId) => captures.tabClosed(tabId))

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const request = message as WorkerRequest
  if (request?.to !== 'worker' || sender.id !== chrome.runtime.id) return undefined
  if (request.type === 'record-progress') {
    captures.recordProgress(request.captureId, request.seconds)
    return undefined
  }
  void hostState({ recheck: request.recheck }).then(sendResponse)
  return true
})

const seam: CaptureSeam = {
  listeners,
  settled: (id) => captures.settled(id),
  timeline: (id) => captures.timeline(id),
  latest: () => captures.latest(),
  host: hostState,
}
Object.defineProperty(globalThis, SEAM_GLOBAL, { value: seam })
