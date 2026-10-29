export type SourceKind = 'file' | 'hls'

export const STREAM_PERMISSIONS = { permissions: ['webRequest'], origins: ['<all_urls>'] }

export interface StreamSource {
  url: string
  as: SourceKind
  seenAt: number
}

export const SOURCE_URL_PATTERNS = ['*://*/*.m3u8*', '*://*/*.mp4*', '*://*/*.webm*', '*://*/*.mov*', '*://*/*.m4v*']

const RANGE_PARAMS = ['bytestart', 'byteend', 'range', 'bytes']

export function classifySource(raw: string): { url: string; as: SourceKind } | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const path = url.pathname.toLowerCase()
  if (path.endsWith('.m3u8')) return { url: url.href, as: 'hls' }
  if (!/\.(mp4|webm|mov|m4v)$/.test(path)) return null
  for (const name of RANGE_PARAMS) url.searchParams.delete(name)
  return { url: url.href, as: 'file' }
}

/** Seconds two durations may differ by and still be one video: players report
 *  the media's end, playlists the sum of their segments. */
const SAME_LENGTH_S = 1

export interface Probed {
  durations: readonly (number | null)[]
  masters: readonly boolean[]
}

export function pickSource(sources: readonly StreamSource[], probed: Probed, videoDuration: number | null): StreamSource | null {
  const scored = sources
    .map((source, i) => ({ source, duration: probed.durations[i] ?? null, weight: probed.masters[i] ? 2 : source.as === 'hls' ? 1 : 0 }))
    .filter(({ duration }) => duration !== null && duration > 0)
  const rank = (a: (typeof scored)[number], b: (typeof scored)[number]) => b.weight - a.weight || b.source.seenAt - a.source.seenAt
  if (videoDuration === null) return scored.sort(rank)[0]?.source ?? null
  const tolerance = Math.max(SAME_LENGTH_S, videoDuration * 0.03)
  return scored.filter(({ duration }) => Math.abs(duration! - videoDuration) <= tolerance).sort(rank)[0]?.source ?? null
}
