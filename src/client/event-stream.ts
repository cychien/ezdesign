import { EventHub, type HubEvent, type HubRequest } from './event-hub.js'

/** Subscribe to the daemon's event stream through the shared `EventHub`, or
 *  through a hub of this tab's own where SharedWorker is missing or its script
 *  will not load. */
export function subscribeEvents(opts: {
  url: string
  workerUrl: string
  events: string[]
  onEvent: (event: HubEvent) => void
}): void {
  const { url, workerUrl, events, onEvent } = opts
  const direct = () =>
    new EventHub((u) => new EventSource(u)).receive({ postMessage: onEvent }, { t: 'subscribe', url, events })
  if (typeof SharedWorker === 'undefined') return direct()
  let worker: SharedWorker
  try {
    worker = new SharedWorker(workerUrl, { name: url })
  } catch {
    return direct()
  }
  let heard = false
  const { port } = worker
  const send = (request: HubRequest) => port.postMessage(request)
  port.onmessage = (e: MessageEvent<HubEvent>) => {
    heard = true
    onEvent(e.data)
  }
  worker.onerror = () => {
    if (!heard) direct()
  }
  send({ t: 'subscribe', url: new URL(url, location.href).href, events })
  window.addEventListener('pagehide', () => send({ t: 'leave' }))
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) send({ t: 'subscribe', url: new URL(url, location.href).href, events })
  })
}
