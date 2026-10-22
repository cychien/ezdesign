export interface PixelSize {
  width: number
  height: number
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end))

export function webpSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') return null
  const at = (i: number) => bytes[i]!
  switch (ascii(bytes, 12, 16)) {
    case 'VP8X':
      return {
        width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)),
        height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)),
      }
    case 'VP8L': {
      if (at(20) !== 0x2f) return null
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
    case 'VP8 ':
      if (at(23) !== 0x9d || at(24) !== 0x01 || at(25) !== 0x2a) return null
      return { width: (at(26) | (at(27) << 8)) & 0x3fff, height: (at(28) | (at(29) << 8)) & 0x3fff }
    default:
      return null
  }
}

export function pngSize(bytes: Uint8Array): PixelSize | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || !signature.every((b, i) => bytes[i] === b) || ascii(bytes, 12, 16) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
