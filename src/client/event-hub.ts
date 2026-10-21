/** One daemon event stream shared by every shell tab of a session.
 *
 *  Chrome allows six HTTP/1.1 connections per origin, and an event stream holds
 *  one for as long as the page is open. One stream per tab ran out at the third
 *  tab: every request after that queued forever, a send included. The hub runs
 *  in a SharedWorker, so a browser holds one connection however many tabs are
 *  open.
 *
 *  A tab that joins gets the daemon's full first flush, the same as a tab with
 *  its own stream: the hub reopens the stream, which costs the tabs already
 *  there one repeated snapshot and saves the hub from knowing what a flush is. */

export interface SourceLike {
  addEventListener(type: string, listener: (e: { data: string }) => void): void
  close(): void
}

export interface PortLike {
  postMessage(message: HubEvent): void
}

/** What a tab sends the hub. */
export type HubRequest = { t: 'subscribe'; url: string; events: string[] } | { t: 'leave' }

/** What the hub sends a tab: one event of the stream. */
export interface HubEvent {
  type: string
  data: string
}

export class EventHub {
  private readonly ports = new Set<PortLike>()
  private readonly events = new Set<string>()
  private source: SourceLike | null = null
  /** Streams replaced but kept until the replacement opens, so the daemon never
   *  sees a moment with no shell connected. */
  private retiring: SourceLike[] = []
  private url: string | null = null

  constructor(private readonly open: (url: string) => SourceLike) {}

  receive(port: PortLike, request: HubRequest): void {
    if (request.t === 'leave') {
      this.ports.delete(port)
      if (this.ports.size === 0) this.close()
      return
    }
    this.ports.add(port)
    this.url = request.url
    for (const type of request.events) this.events.add(type)
    this.reopen()
  }

  private reopen(): void {
    if (this.source) this.retiring.push(this.source)
    const next = this.open(this.url!)
    this.source = next
    next.addEventListener('open', () => {
      if (this.source === next) this.retire()
    })
    for (const type of this.events) {
      next.addEventListener(type, (e) => {
        if (this.source !== next) return
        for (const port of this.ports) port.postMessage({ type, data: e.data })
      })
    }
  }

  private retire(): void {
    for (const old of this.retiring) old.close()
    this.retiring = []
  }

  private close(): void {
    this.retire()
    this.source?.close()
    this.source = null
  }
}
