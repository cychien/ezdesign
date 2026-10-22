import type { CaptureId, HostState } from './messages.js'

export interface SeamClickData {
  menuItemId: string | number
  mediaType?: 'image' | 'video' | 'audio'
  srcUrl?: string
  pageUrl?: string
  frameId?: number
}

export interface SeamTab {
  id?: number
  windowId: number
  url?: string
  title?: string
}

export type CaptureOutcome =
  | { type: 'saved'; itemId: string; merged: boolean }
  | { type: 'cancelled' }
  | { type: 'failed'; message: string }

export interface CaptureTimeline {
  triggered: number
  dialogShown?: number
  previewShown?: number
  confirmed?: number
  committed?: number
  beforeDialog: string[]
}

export interface CaptureSeam {
  listeners: {
    contextMenuClicked(info: SeamClickData, tab?: SeamTab): Promise<CaptureId | null>
  }
  settled(id: CaptureId): Promise<CaptureOutcome>
  timeline(id: CaptureId): CaptureTimeline | null
  latest(): CaptureId | null
  host(options?: { recheck?: boolean }): Promise<HostState>
}

export const SEAM_GLOBAL = '__ezCapture'
