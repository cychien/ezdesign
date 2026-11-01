import { DESKTOP_BRIDGE, type DesktopBridge } from '../desktop-wire.js'
import type { ProjectOpenedWire } from '../projects/wire.js'

interface Navigation {
  showProject(opened: ProjectOpenedWire): void
  showHome(homeUrl: string): void
}

export type Host =
  | ({ readonly kind: 'browser' } & Navigation)
  | ({
      readonly kind: 'desktop'
      readonly trafficLightRoom: number
      pickFolder(): Promise<string | null>
      pathForFile(file: File): string
    } & Navigation)

const browserHost: Host = {
  kind: 'browser',
  showProject: (opened) => location.assign(opened.shellUrl),
  showHome: (homeUrl) => location.assign(homeUrl),
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
