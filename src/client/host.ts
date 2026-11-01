import { DESKTOP_BRIDGE, type DesktopBridge } from '../desktop-wire.js'
import type { ProjectOpenedWire } from '../projects/wire.js'

export interface Host {
  readonly kind: 'browser' | 'desktop'
  /** Zero in a browser. */
  readonly trafficLightRoom: number
  showProject(opened: ProjectOpenedWire): void
  showHome(homeUrl: string): void
  readonly pickFolder: (() => Promise<string | null>) | null
  readonly pathForFile: ((file: File) => string) | null
}

const browserHost: Host = {
  kind: 'browser',
  trafficLightRoom: 0,
  showProject: (opened) => location.assign(opened.shellUrl),
  showHome: (homeUrl) => location.assign(homeUrl),
  pickFolder: null,
  pathForFile: null,
}

function desktopHost(bridge: DesktopBridge): Host {
  return {
    kind: 'desktop',
    trafficLightRoom: bridge.trafficLightRoom,
    showProject: (opened) => bridge.showProject(opened),
    showHome: () => bridge.showHome(),
    pickFolder: () => bridge.pickFolder(),
    pathForFile: (file) => bridge.pathForFile(file),
  }
}

export const host: Host = (() => {
  const bridge = (window as unknown as Record<string, DesktopBridge | undefined>)[DESKTOP_BRIDGE]
  return bridge ? desktopHost(bridge) : browserHost
})()

if (host.kind === 'desktop') {
  document.documentElement.dataset.host = 'desktop'
  document.documentElement.style.setProperty('--traffic-light-room', `${host.trafficLightRoom}px`)
}
