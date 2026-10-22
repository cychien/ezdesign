/** Listeners are registered synchronously at the top level, as MV3 requires
 *  for a worker that Chrome restarts to deliver an event. */

import type { HostState, WorkerRequest } from '../shared/messages.js'
import { type CaptureSeam, SEAM_GLOBAL } from '../shared/seam.js'
import { createHostLink, extensionVersion } from './host-link.js'

function asset(name: string): string {
  const worker = chrome.runtime.getManifest().background?.service_worker ?? ''
  return `${worker.slice(0, worker.lastIndexOf('/') + 1)}${name}`
}

const host = createHostLink()

const RELOADED_FOR = 'reloadedForHostVersion'

async function reloadWhenStale(state: HostState): Promise<void> {
  if (state.type !== 'ready' || state.version === extensionVersion()) return
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

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL(asset('setup.html')) })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const request = message as WorkerRequest
  if (request?.to !== 'worker' || sender.id !== chrome.runtime.id) return undefined
  void hostState({ recheck: request.recheck }).then(sendResponse)
  return true
})

const seam: CaptureSeam = { host: hostState }
Object.defineProperty(globalThis, SEAM_GLOBAL, { value: seam })
