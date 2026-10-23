import { createHash } from 'node:crypto'

/** The smallest bytes the library's sniffers and size readers accept. */
export function png(width: number, height: number, bytes = 64, seed = 'x'): Buffer {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  const fill = createHash('sha256').update(seed).digest()
  const body = Buffer.alloc(Math.max(0, bytes - head.length))
  for (let i = 0; i < body.length; i += fill.length) fill.copy(body, i)
  return Buffer.concat([head, body])
}

export function webp(width: number, height: number): Buffer {
  const out = Buffer.alloc(30)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(22, 4)
  out.write('WEBPVP8L', 8, 'ascii')
  out.writeUInt32LE(5, 16)
  out[20] = 0x2f
  out.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21)
  return out
}
