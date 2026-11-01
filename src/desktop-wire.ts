import type { ProjectOpenedWire } from './projects/wire.js'

/** Versioned apart from the package: the app updates only with its native
 *  shell, the daemon from npm, so the app must keep talking to newer daemons.
 *  A breaking change bumps it; a daemon keeps serving the old number while
 *  released apps speak it. */
export const DESKTOP_CONTRACT = 1

export const DESKTOP_HEADER = 'x-ezdesign-desktop'

export interface DesktopOpenRequest {
  path: string
}
export type DesktopOpenAnswer = ProjectOpenedWire

export interface DesktopQuitAnswer {
  stopped: number
}

export const DESKTOP_BRIDGE = 'ezdesignDesktop'

export interface DesktopBridge {
  readonly contract: number
  readonly trafficLightRoom: number
  pickFolder(): Promise<string | null>
  /** `''` for a dropped item with no path. */
  pathForFile(file: File): string
  showProject(opened: ProjectOpenedWire): void
  showHome(): void
}

export const DESKTOP_IPC = {
  pickFolder: 'ezdesign:pick-folder',
  showProject: 'ezdesign:show-project',
  showHome: 'ezdesign:show-home',
} as const
