import type { AnsweredRequest, AnsweredType, CaptureContext, ReplyOf, Staged, WireError } from '../../capture-wire.js'
import type {
  DialogToWorker,
  EncodedThumb,
  HostState,
  MediaReplies,
  PageCommand,
  PageReplies,
  Size,
  ViewportRect,
  WorkerToDialog,
} from '../shared/messages.js'
import type { TabRef } from '../shared/plan.js'

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
  request<A extends Ask<AnsweredType>>(ask: A, options?: RequestOptions): Promise<ReplyOf<A['t']>>
  upload(
    input: { capture: string; kind: 'image' | 'screenshot' | 'frame'; context: CaptureContext },
    bytes: Uint8Array,
    options?: RequestOptions,
  ): Promise<Staged>
  read(capture: string, options?: RequestOptions): AsyncIterable<string>
  onLost(listener: () => void): () => void
}

export interface MediaClient {
  warm(): Promise<void>
  thumbnail(pieces: AsyncIterable<string>, at?: number): Promise<EncodedThumb | null>
  crop(screenshot: string, rect: ViewportRect | null, viewport: Size, original: boolean): Promise<MediaReplies['crop']>
}

export const THUMBNAIL_SOURCE_MAX_BYTES = 256 * 1024 * 1024

export interface PageAgent {
  ensure(tab: TabRef, frameId: number): Promise<boolean>
  send<C extends PageCommand>(tab: TabRef, frameId: number, command: C): Promise<PageReplies[C['type']]>
}

export interface BrowserOps {
  captureVisibleTab(windowId: number, format: 'png' | 'jpeg'): Promise<string>
  dialogPath(captureId: string): string
  openDialogWindow(captureId: string): Promise<number>
  closeWindow(windowId: number): Promise<void>
  fetchWithCookies(url: string, signal: AbortSignal): Promise<Uint8Array>
  readonly userAgent: string
  now(): number
}

export interface DialogPort {
  readonly name: string
  postMessage(message: WorkerToDialog): void
  disconnect(): void
  onMessage: { addListener(listener: (message: DialogToWorker) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
}
