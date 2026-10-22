/** One `connectNative` port, which also keeps the worker alive while it is
 *  open (Chrome 105+); `sendNativeMessage` would start a host per message. */

import {
  type AnsweredType,
  EXTENSION_CHUNK_BYTES,
  HOST_NAME,
  PROTOCOL,
  type ReplyOf,
  parseHostMessage,
  parseReply,
} from '../../capture-wire.js'
import { sha256Hex, toBase64 } from '../shared/bytes.js'
import type { HostState } from '../shared/messages.js'
import { type Ask, HostFailure, type HostFault, type HostLink, type RequestOptions } from './ports.js'

export const INSTALL_COMMAND = 'npx -y @cychien/ezdesign@latest extension install'
export const IDLE_DISCONNECT_MS = 5 * 60_000
const HELLO_TIMEOUT_MS = 10_000

/** What Chrome reports in `lastError` when it has no manifest for the host, or
 *  one that does not list this extension. */
const MISSING_HOST = [
  'Specified native messaging host not found.',
  'Access to the specified native messaging host is forbidden.',
]

export interface HostLinkHandle extends HostLink {
  readonly hostVersion: string | null
  hold(): () => void
}

interface Pending {
  type: AnsweredType
  resolve(value: unknown): void
  reject(error: HostFailure): void
  onProgress?: RequestOptions['onProgress']
  onBytes?(seq: number, data: string): void
}

export function extensionVersion(): string {
  const manifest = chrome.runtime.getManifest()
  return manifest.version_name ?? manifest.version
}

export function createHostLink(): HostLinkHandle {
  let port: chrome.runtime.Port | null = null
  let connected: Promise<HostState> | null = null
  let nextId = 1
  let holds = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let hostVersion: string | null = null
  const pending = new Map<number, Pending>()
  const lostListeners = new Set<() => void>()

  const failAll = (fault: HostFault) => {
    for (const entry of pending.values()) entry.reject(new HostFailure(fault))
    pending.clear()
  }

  const drop = (which: chrome.runtime.Port) => {
    if (port !== which) return
    port = null
    connected = null
    which.disconnect()
  }

  const settleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    if (!port || holds > 0 || pending.size > 0) return
    const idle = port
    idleTimer = setTimeout(() => drop(idle), IDLE_DISCONNECT_MS)
  }

  const onMessage = (raw: unknown) => {
    const message = parseHostMessage(raw)
    if (!message || message.t === 'fatal') {
      failAll(
        message?.error ?? {
          code: 'incompatible',
          message: 'the host sent a message this extension does not understand',
          host: PROTOCOL,
        },
      )
      if (port) drop(port)
      return
    }
    const entry = pending.get(message.re)
    if (!entry) return
    if (message.t === 'progress') return entry.onProgress?.(message.received, message.total)
    if (message.t === 'bytes') return entry.onBytes?.(message.seq, message.data)
    pending.delete(message.re)
    if (message.t === 'error') {
      entry.reject(new HostFailure(message.error))
    } else {
      const value = parseReply(entry.type, message.value)
      if (value === null) {
        entry.reject(
          new HostFailure({ code: 'incompatible', message: `the host's ${entry.type} reply did not parse`, host: PROTOCOL }),
        )
      } else {
        entry.resolve(value)
      }
    }
    settleIdle()
  }

  const register = (target: chrome.runtime.Port, entry: Pending, signal?: AbortSignal): number => {
    const id = nextId++
    pending.set(id, entry)
    if (idleTimer) clearTimeout(idleTimer)
    signal?.addEventListener('abort', () => pending.has(id) && target.postMessage({ t: 'cancel', ref: id }), {
      once: true,
    })
    return id
  }

  const send = <A extends Ask<AnsweredType>>(target: chrome.runtime.Port, ask: A, options: RequestOptions = {}) =>
    new Promise<ReplyOf<A['t']>>((resolve, reject) => {
      const entry: Pending = {
        type: ask.t,
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress: options.onProgress,
      }
      target.postMessage({ ...ask, id: register(target, entry, options.signal) })
    })

  const connect = (): Promise<HostState> => {
    const opened = chrome.runtime.connectNative(HOST_NAME)
    port = opened
    let greeted = false
    const disconnected = new Promise<HostState>((resolve) => {
      opened.onDisconnect.addListener(() => {
        const message = chrome.runtime.lastError?.message ?? 'the host closed the connection'
        if (port === opened) {
          port = null
          connected = null
        }
        failAll({ code: 'host-lost', message })
        if (greeted) for (const listener of lostListeners) listener()
        resolve(MISSING_HOST.includes(message) ? { type: 'missing', installCommand: INSTALL_COMMAND } : { type: 'broken', message })
      })
    })
    opened.onMessage.addListener(onMessage)
    const hello = send(opened, { t: 'hello', protocol: PROTOCOL, extension: { version: extensionVersion() } }).then(
      (welcome): HostState => {
        greeted = true
        hostVersion = welcome.host.version
        settleIdle()
        return { type: 'ready', version: welcome.host.version, node: welcome.host.node, libraryDir: welcome.library.dir }
      },
      (failure: HostFailure) => stateOf(failure.fault),
    )
    const timeout = new Promise<HostState>((resolve) =>
      setTimeout(
        () => resolve({ type: 'broken', message: `the host did not answer in ${HELLO_TIMEOUT_MS / 1000} s` }),
        HELLO_TIMEOUT_MS,
      ),
    )
    return Promise.race([hello, disconnected, timeout]).then((state) => {
      if (state.type !== 'ready') drop(opened)
      return state
    })
  }

  const state = (options: { recheck?: boolean } = {}): Promise<HostState> => {
    if (connected && options.recheck) {
      connected = connected.then((current) => (current.type === 'ready' && port ? current : connect()))
    }
    connected ??= connect()
    return connected
  }

  const ready = async (): Promise<chrome.runtime.Port> => {
    const current = await state({ recheck: true })
    if (current.type !== 'ready' || !port) {
      throw new HostFailure({ code: 'host-unavailable', message: describeHost(current), state: current })
    }
    return port
  }

  const link: HostLinkHandle = {
    get hostVersion() {
      return hostVersion
    },
    state,
    async request(ask, options) {
      return send(await ready(), ask, options)
    },
    async upload(input, bytes, options = {}) {
      const target = await ready()
      const release = link.hold()
      try {
        const sha256 = await sha256Hex(bytes)
        await send(target, { t: 'upload', capture: input.capture, kind: input.kind, size: bytes.length, context: input.context })
        for (let offset = 0; offset < bytes.length && !options.signal?.aborted; offset += EXTENSION_CHUNK_BYTES) {
          const data = toBase64(bytes.subarray(offset, offset + EXTENSION_CHUNK_BYTES))
          target.postMessage({ t: 'chunk', capture: input.capture, offset, data })
        }
        if (options.signal?.aborted) {
          await send(target, { t: 'discard', capture: input.capture })
          throw new HostFailure({ code: 'cancelled', message: 'the upload was cancelled' })
        }
        return await send(target, { t: 'upload-end', capture: input.capture, sha256 })
      } finally {
        release()
      }
    },
    async *read(capture, options = {}) {
      const target = await ready()
      const queue: string[] = []
      let wake: (() => void) | null = null
      let done = false
      let failure: HostFailure | null = null
      let expected = 0
      const id = register(
        target,
        {
          type: 'read',
          resolve: () => {
            done = true
            wake?.()
          },
          reject: (error) => {
            failure = error
            wake?.()
          },
          onBytes: (seq, data) => {
            if (seq !== expected++) {
              failure = new HostFailure({ code: 'integrity', message: `read piece ${seq} arrived out of order` })
            } else {
              queue.push(data)
            }
            wake?.()
          },
        },
        options.signal,
      )
      target.postMessage({ t: 'read', id, capture })
      for (;;) {
        if (queue.length) {
          yield queue.shift()!
          continue
        }
        if (failure) throw failure
        if (done) return
        await new Promise<void>((resolve) => (wake = resolve))
        wake = null
      }
    },
    onLost(listener) {
      lostListeners.add(listener)
      return () => lostListeners.delete(listener)
    },
    hold() {
      holds++
      if (idleTimer) clearTimeout(idleTimer)
      let released = false
      return () => {
        if (released) return
        released = true
        holds--
        settleIdle()
      }
    },
  }
  return link
}

function stateOf(fault: HostFault): HostState {
  if (fault.code === 'incompatible') {
    return {
      type: 'incompatible',
      older: fault.host.max < PROTOCOL.min ? 'host' : 'extension',
      installCommand: INSTALL_COMMAND,
    }
  }
  if (fault.code === 'host-unavailable') return fault.state
  return { type: 'broken', message: fault.message }
}

export function describeHost(state: HostState): string {
  switch (state.type) {
    case 'ready':
      return `connected to ezdesign ${state.version}`
    case 'connecting':
      return 'connecting to the ezdesign host'
    case 'missing':
      return `the ezdesign host is not installed; run ${state.installCommand}`
    case 'incompatible':
      return `the ezdesign ${state.older} is out of date; run ${state.installCommand}`
    case 'broken':
      return state.message
  }
}
