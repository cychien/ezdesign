import { SOURCE_URL_PATTERNS, STREAM_PERMISSIONS, type StreamSource, classifySource } from '../shared/streams.js'
import type { StreamObserver } from './ports.js'

const KEPT_PER_TAB = 50
const key = (tabId: number) => `streams:${tabId}`

export function createStreamObserver(): StreamObserver {
  const pending = new Map<number, StreamSource[]>()
  let writing = Promise.resolve()

  const remember = (tabId: number, source: StreamSource) => {
    const list = pending.get(tabId) ?? []
    list.push(source)
    pending.set(tabId, list)
    writing = writing.then(async () => {
      const fresh = pending.get(tabId)
      if (!fresh?.length) return
      pending.delete(tabId)
      const stored = ((await chrome.storage.session.get(key(tabId)))[key(tabId)] as StreamSource[] | undefined) ?? []
      const seen = new Set(fresh.map((s) => s.url))
      const merged = [...fresh.reverse(), ...stored.filter((s) => !seen.has(s.url))].slice(0, KEPT_PER_TAB)
      await chrome.storage.session.set({ [key(tabId)]: merged })
    })
  }

  const onRequest = (details: chrome.webRequest.RequestDetails) => {
    if (details.tabId < 0) return
    const source = classifySource(details.url)
    if (source) remember(details.tabId, { ...source, seenAt: details.timeStamp })
  }

  // Synchronous at the top of the worker when already granted, as MV3 needs to
  // deliver an event to a worker it restarted; added the moment a grant lands.
  const listen = () => {
    if (typeof chrome.webRequest === 'undefined' || chrome.webRequest.onBeforeRequest.hasListener(onRequest)) return
    chrome.webRequest.onBeforeRequest.addListener(onRequest, {
      urls: SOURCE_URL_PATTERNS,
      types: ['xmlhttprequest', 'media', 'other'],
    })
  }
  listen()
  chrome.permissions.onAdded.addListener(listen)

  const forget = (tabId: number) => {
    pending.delete(tabId)
    void chrome.storage.session.remove(key(tabId))
  }
  chrome.tabs.onRemoved.addListener(forget)

  return {
    granted: () => chrome.permissions.contains(STREAM_PERMISSIONS),
    async sourcesFor(tabId) {
      await writing
      return ((await chrome.storage.session.get(key(tabId)))[key(tabId)] as StreamSource[] | undefined) ?? []
    },
  }
}
