import type { ProjectOpenedWire } from '../projects/wire.js'

export interface Host {
  readonly kind: 'browser' | 'desktop'
  showProject(opened: ProjectOpenedWire): void
  showHome(homeUrl: string): void
}

export const host: Host = {
  kind: 'browser',
  showProject: (opened) => location.assign(opened.shellUrl),
  showHome: (homeUrl) => location.assign(homeUrl),
}
