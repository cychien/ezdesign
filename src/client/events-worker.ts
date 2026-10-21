import { EventHub, type HubRequest } from './event-hub.js'

const hub = new EventHub((url) => new EventSource(url))

;(self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (e) => {
  const port = e.ports[0]!
  port.onmessage = (m: MessageEvent<HubRequest>) => hub.receive(port, m.data)
}
