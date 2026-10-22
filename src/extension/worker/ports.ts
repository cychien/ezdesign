import type { AnsweredRequest, AnsweredType, CaptureContext, ReplyOf, Staged, WireError } from '../../capture-wire.js'
import type { HostState } from '../shared/messages.js'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type Ask<K extends AnsweredType> = DistributiveOmit<Extract<AnsweredRequest, { t: K }>, 'id'>

export type HostFault =
  | WireError
  | { code: 'host-lost'; message: string }
  | { code: 'host-unavailable'; message: string; state: HostState }

export class HostFailure extends Error {
  constructor(readonly fault: HostFault) {
    super(fault.message)
    this.name = 'HostFailure'
  }
}

export interface RequestOptions {
  signal?: AbortSignal
  onProgress?(received: number, total: number | null): void
}

export interface HostLink {
  state(options?: { recheck?: boolean }): Promise<HostState>
  request<K extends AnsweredType>(ask: Ask<K>, options?: RequestOptions): Promise<ReplyOf<K>>
  upload(
    input: { capture: string; kind: 'image' | 'screenshot' | 'frame'; context: CaptureContext },
    bytes: Uint8Array,
    options?: RequestOptions,
  ): Promise<Staged>
  read(capture: string, options?: RequestOptions): AsyncIterable<string>
  onLost(listener: () => void): () => void
}
