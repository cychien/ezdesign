import type { VideoSettleWire } from '../../attachment-wire.js'
import type { DigestEvent, DigestJob } from './worker.js'

const IDLE_MS = 30_000
const STALL_MS = 20_000
const RETRY_MS = 10_000

export interface VideoDigests {
  observe(pending: readonly string[]): void
  progress(id: string): number
}

export function videoDigests(api: string, workerUrl: string, onChange: () => void): VideoDigests {
  const fractions = new Map<string, number>()
  const queue: string[] = []
  const resting = new Set<string>()
  let current: string | null = null
  let worker: Worker | null = null
  let stallTimer = 0
  let idleTimer = 0

  const spawn = (): Worker => {
    const w = new Worker(workerUrl)
    w.onmessage = (e: MessageEvent<DigestEvent>) => handle(e.data)
    w.onerror = (e) => {
      e.preventDefault()
      crashed('the digest worker crashed')
    }
    return w
  }

  const next = (): void => {
    if (current) return
    const id = queue.shift()
    if (!id) {
      idleTimer = window.setTimeout(() => {
        worker?.terminate()
        worker = null
      }, IDLE_MS)
      return
    }
    clearTimeout(idleTimer)
    current = id
    worker ??= spawn()
    worker.postMessage({ id, api } satisfies DigestJob)
    armStall()
  }

  const armStall = (): void => {
    clearTimeout(stallTimer)
    stallTimer = window.setTimeout(() => crashed('the digest stopped answering'), STALL_MS)
  }

  const finish = (id: string): void => {
    clearTimeout(stallTimer)
    fractions.delete(id)
    current = null
    next()
    onChange()
  }

  const handle = (event: DigestEvent): void => {
    if (event.id !== current) return
    if (event.type === 'progress') {
      fractions.set(event.id, event.fraction)
      armStall()
      onChange()
      return
    }
    if (event.type === 'error') {
      resting.add(event.id)
      window.setTimeout(() => resting.delete(event.id), RETRY_MS)
    }
    finish(event.id)
  }

  const crashed = (detail: string): void => {
    worker?.terminate()
    worker = null
    const id = current
    if (!id) return
    const body: VideoSettleWire = { state: 'failed', reason: 'crashed', detail }
    void fetch(`${api}/attachments/${id}/video`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
    finish(id)
  }

  return {
    observe(pending) {
      const listed = new Set(pending)
      for (const id of pending) {
        if (fractions.has(id) || resting.has(id)) continue
        fractions.set(id, 0)
        queue.push(id)
      }
      for (const id of [...fractions.keys()]) {
        if (listed.has(id) || id === current) continue
        fractions.delete(id)
        const at = queue.indexOf(id)
        if (at >= 0) queue.splice(at, 1)
      }
      next()
    },
    progress: (id) => fractions.get(id) ?? 0,
  }
}
