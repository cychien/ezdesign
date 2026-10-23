export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function playbackText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(s / 3600)
  const mm = String(Math.floor(s / 60) % 60).padStart(hours ? 2 : 1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
