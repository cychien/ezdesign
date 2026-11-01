import { DESKTOP_BRIDGE, type DesktopBridge, type DesktopLayout, type DesktopUpdateOffer } from '../desktop-wire.js'
import type { ProjectOpenedWire } from '../projects/wire.js'

export type Host =
  | { readonly kind: 'browser'; showProject(opened: ProjectOpenedWire): void }
  | {
      readonly kind: 'desktop'
      showProject(opened: ProjectOpenedWire): void
      pickFolder(): Promise<string | null>
      pathForFile(file: File): string
      toggleSidebar(): void
      onLayout(listener: (layout: DesktopLayout) => void): void
      /** Never called by an app too old to offer updates here. */
      onUpdate(listener: (offer: DesktopUpdateOffer | null) => void): void
      takeUpdate(): void
    }

const bridge = (window as unknown as Record<string, DesktopBridge | undefined>)[DESKTOP_BRIDGE]

export const host: Host = bridge
  ? {
      kind: 'desktop',
      showProject: (opened) => bridge.showProject(opened),
      pickFolder: () => bridge.pickFolder(),
      pathForFile: (file) => bridge.pathForFile(file),
      toggleSidebar: () => bridge.toggleSidebar(),
      onLayout: (listener) => bridge.onLayout(listener),
      onUpdate: (listener) => bridge.onUpdate?.(listener),
      takeUpdate: () => bridge.takeUpdate?.(),
    }
  : { kind: 'browser', showProject: (opened) => location.assign(opened.shellUrl) }

/** A page at the window's left edge, with the sidebar closed, sits under the
 *  traffic lights; the title bar is also what drags the window. */
if (bridge) {
  const root = document.documentElement
  root.dataset.host = 'desktop'
  root.style.setProperty('--sidebar-width', `${bridge.sidebarWidth}px`)
  root.style.setProperty('--pane-inset', `${bridge.paneInset}px`)
  root.style.setProperty('--pane-radius', `${bridge.paneRadius}px`)
  bridge.onLayout(({ sidebar }) => {
    root.dataset.sidebar = sidebar ? 'open' : 'closed'
    root.style.setProperty('--traffic-light-room', sidebar ? '0px' : `${bridge.trafficLightRoom}px`)
  })
}
