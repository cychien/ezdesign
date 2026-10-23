import type { LibraryItemWire, LibraryPageWire, LibraryPatchWire, LibraryTagWire } from '../../library-wire.js'

export interface LibraryQuery {
  q: string
  tags: readonly string[]
  before: string | null
}

export interface LibraryApi {
  items(query: LibraryQuery): Promise<LibraryPageWire>
  tags(): Promise<LibraryTagWire[]>
  update(id: string, patch: LibraryPatchWire): Promise<LibraryItemWire>
  remove(id: string): Promise<void>
}

async function answer<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body as T
}

export function libraryApi(base: string): LibraryApi {
  return {
    items: async ({ q, tags, before }) => {
      const params = new URLSearchParams()
      if (q) params.set('q', q)
      for (const tag of tags) params.append('tag', tag)
      if (before) params.set('before', before)
      return answer(await fetch(`${base}/library/items?${params}`))
    },
    tags: async () => (await answer<{ tags: LibraryTagWire[] }>(await fetch(`${base}/library/tags`))).tags,
    update: async (id, patch) =>
      answer(
        await fetch(`${base}/library/items/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }),
      ),
    remove: async (id) => {
      await answer(await fetch(`${base}/library/items/${id}`, { method: 'DELETE' }))
    },
  }
}
