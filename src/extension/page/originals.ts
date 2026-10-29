/** The marker the isolated page agent puts on the video a capture is about, so
 *  a function running in the page's own world can find the same element. */
export const TARGET_ATTR = 'data-ez-capture-target'

/** Runs in the page's MAIN world through `scripting.executeScript`, so it must
 *  stand alone: no imports, nothing from the scope around it.
 *
 *  A stream's player knows only segments, but some sites keep the original
 *  files in the page's own data. X does: every tweet's media carries
 *  `video_info.variants`, one MP4 per resolution, in the React props of the
 *  tweet around the player. The props are searched rather than walked by a
 *  fixed path, so a reshuffle of X's components does not lose them. */
export function originalOfTarget(attr: string): string | null {
  type Variant = { content_type?: string; bitrate?: number; url?: string }
  type Media = { video_info?: { variants?: Variant[] } }
  const video = document.querySelector<HTMLVideoElement>(`video[${attr}]`)
  if (!video) return null
  const scope = video.closest('article') ?? video.parentElement
  if (!scope) return null
  const mediaId = /\/(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\/(\d+|[\w-]+)/.exec(video.poster)?.[1] ?? null

  const found: Variant[][] = []
  const seen = new WeakSet<object>()
  const search = (value: unknown, depth: number) => {
    if (depth > 6 || typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    const variants = (value as Media).video_info?.variants
    if (Array.isArray(variants)) found.push(variants)
    for (const key of Object.keys(value)) {
      if (key === 'children' || key.startsWith('_') || key.startsWith('$$')) continue
      search((value as Record<string, unknown>)[key], depth + 1)
    }
  }
  const fiberKey = Object.keys(scope).find((k) => k.startsWith('__reactFiber'))
  let fiber = fiberKey ? (scope as unknown as Record<string, { memoizedProps?: unknown; return?: unknown }>)[fiberKey] : undefined
  for (let hops = 0; fiber && hops < 40 && !found.length; hops++) {
    search(fiber.memoizedProps, 0)
    fiber = fiber.return as typeof fiber
  }

  const files = found
    .filter((variants) => mediaId === null || variants.some((v) => v.url?.includes(mediaId)))
    .flat()
    .filter((v) => v.content_type === 'video/mp4' && typeof v.url === 'string' && /^https?:\/\//.test(v.url))
  files.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
  return files[0]?.url ?? null
}
