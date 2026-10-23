export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** What a reference is called: its page, or what it was when it came from no page. */
export function sourceName(source: { pageUrl: string; pageTitle: string }): string {
  return source.pageTitle || hostOf(source.pageUrl) || '貼上的圖片'
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function playbackText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(s / 3600)
  const mm = String(Math.floor(s / 60) % 60).padStart(hours ? 2 : 1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
