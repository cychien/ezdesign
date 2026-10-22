/** A directly downloadable video over this is not stored: it becomes a link
 *  item with its poster. */
export const VIDEO_CAP_BYTES = 200_000_000

/** Long side of the one WebP thumbnail every item may have. */
export const THUMBNAIL_LONG_SIDE = 400

export const TAG_MAX_LENGTH = 64

declare const tagBrand: unique symbol
/** A tag as the user spelled it, trimmed and with inner whitespace collapsed. */
export type TagName = string & { readonly [tagBrand]: 'TagName' }

/** Null for input that is not a tag: empty after trimming, too long, or
 *  holding a comma. */
export function normalizeTag(raw: string): TagName | null {
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (name === '' || name.length > TAG_MAX_LENGTH || /[,，]/.test(name)) return null
  return name as TagName
}

/** What makes two tags the same tag: `Hero` and `hero ` are one. Compatibility
 *  folding first, so full-width `ＵＩ` and `UI` are one too. Suggestions match
 *  a typed prefix against this key, never against SQLite's ASCII-only `lower()`. */
export function tagKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The thumbnail size for a source of `width` x `height`: long side at most
 *  `THUMBNAIL_LONG_SIDE`, never upscaled, never below one pixel. */
export function thumbnailSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, THUMBNAIL_LONG_SIDE / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
