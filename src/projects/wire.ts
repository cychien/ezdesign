import type { DevServerSummaryWire } from '../dev-server/wire.js'

export interface ProjectWire {
  project: string
  name: string
  usedAt: number | null
  exists: boolean
  /** Null while the project has no live session in this daemon. */
  session: { devServer: DevServerSummaryWire } | null
}

export interface ProjectListWire {
  version: string
  projects: ProjectWire[]
}

export interface ProjectOpenedWire {
  project: string
  shellUrl: string
}

export interface ProjectAddWire {
  path: string
}

export interface ProjectRefWire {
  project: string
}

export interface ProjectOpenWire extends ProjectRefWire {
  host: 'desktop' | 'browser'
}
