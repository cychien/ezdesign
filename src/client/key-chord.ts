/** What a shortcut is matched against: a real key event, or one an overlay
 *  forwarded, so only the fields both can supply. */
export interface KeyChord {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
}

const PRINTABLE_ASCII = /^[\x20-\x7e]$/

function physicalCode(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return null
}

/** A modifier-free key. `key` decides wherever the layout types ASCII, which
 *  keeps Dvorak and AZERTY on the letter printed on the cap. Where it does not -
 *  Zhuyin types ㄍ on E, an IME reports `Process` - the physical key decides, so
 *  a shortcut works without switching input sources first. */
export function plainKeyMatches(e: KeyChord, key: string): boolean {
  if (e.metaKey || e.ctrlKey) return false
  if (e.key.toLowerCase() === key.toLowerCase()) return true
  const code = physicalCode(key)
  return code !== null && !PRINTABLE_ASCII.test(e.key) && e.code === code
}
