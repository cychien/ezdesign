import type { DevServerSummaryWire } from '../dev-server/wire.js'
import type { ProjectListWire, ProjectOpenedWire, ProjectWire } from '../projects/wire.js'
import { VERSION_HEADER } from '../version-header.js'
import { host } from './host.js'

export interface ProjectsClient {
  list(): Promise<ProjectListWire>
  go(project: string): Promise<void>
  stop(project: string): Promise<void>
  add(path: string): Promise<ProjectWire>
  hide(project: string): Promise<void>
  watch(onList: (list: ProjectListWire) => void): () => void
}

export function projectsClient(api: string, version: string): ProjectsClient {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${api}/projects${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { [VERSION_HEADER]: version, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (res.status === 409) {
      location.reload()
      throw new Error('ezdesign was updated; reloading')
    }
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${res.status}`)
    return (await res.json()) as T
  }

  return {
    list: () => request<ProjectListWire>(''),
    async go(project) {
      host.showProject(await request<ProjectOpenedWire>('/open', { project, host: host.kind }))
    },
    stop: async (project) => void (await request('/stop', { project })),
    add: (path) => request<ProjectWire>('', { path }),
    hide: async (project) => void (await request('/hide', { project })),
    watch(onList) {
      const source = new EventSource(`${api}/projects/events`)
      source.onmessage = (e) => {
        const list = JSON.parse(e.data as string) as ProjectListWire
        if (list.version !== version) return location.reload()
        onList(list)
      }
      return () => source.close()
    },
  }
}

export function devServerStatus(project: ProjectWire): { phase: string; text: string } | null {
  const server = project.session?.devServer
  if (!server || server.phase === 'idle') return null
  const where = server.origin?.replace(/^https?:\/\//, '')
  const text: Record<DevServerSummaryWire['phase'], string> = {
    idle: '',
    starting: '啟動中',
    running: where ? `執行中 · ${where}` : '執行中',
    external: where ? `你自己的 server · ${where}` : '你自己的 server',
    stopped: '已停止',
    crashed: '停止運作了',
    blocked: '缺少工具',
    'needs-command': '需要啟動指令',
  }
  return { phase: server.phase, text: text[server.phase] }
}
