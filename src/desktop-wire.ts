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

/** What the window shows: whether the project sidebar is open, and which
 *  project fills the rest. */
export interface DesktopLayout {
  sidebar: boolean
  shown: string | null
}

/** At `window[DESKTOP_BRIDGE]` in daemon pages inside the app; read only by
 *  `client/host.ts`. */
export interface DesktopBridge {
  readonly contract: number
  /** Room a page at the window's left edge leaves for the traffic lights. */
  readonly trafficLightRoom: number
  pickFolder(): Promise<string | null>
  /** `''` for a dropped item with no path. */
  pathForFile(file: File): string
  showProject(opened: ProjectOpenedWire): void
  toggleSidebar(): void
  /** Called now and on every change. */
  onLayout(listener: (layout: DesktopLayout) => void): void
}

export const DESKTOP_IPC = {
  pickFolder: 'ezdesign:pick-folder',
  showProject: 'ezdesign:show-project',
  toggleSidebar: 'ezdesign:toggle-sidebar',
  layout: 'ezdesign:layout',
  layoutNow: 'ezdesign:layout-now',
} as const
