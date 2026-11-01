import type { AccountWire } from '../account.js'
import type { DevServerSummaryWire } from '../dev-server/wire.js'

export interface ProjectWire {
  project: string
  name: string
  usedAt: number | null
  exists: boolean
  /** Null while the project has no live session in this daemon. */
  session: {
    devServer: DevServerSummaryWire
    /** The agent is taking a turn, or stopping one. */
    agentWorking: boolean
  } | null
}

export interface ProjectListWire {
  version: string
  projects: ProjectWire[]
  /** The daemon's one sign-in, which every project shares. */
  account: AccountWire
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
