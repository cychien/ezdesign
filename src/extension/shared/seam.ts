import type { HostState } from './messages.js'

export interface CaptureSeam {
  host(options?: { recheck?: boolean }): Promise<HostState>
}

export const SEAM_GLOBAL = '__ezCapture'
