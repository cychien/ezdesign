/** Chrome's native messaging framing: a 32-bit length in native byte order,
 *  then that many bytes of UTF-8 JSON. */

import { endianness } from 'node:os'
import { type Readable, Writable } from 'node:stream'
import { EXTENSION_MESSAGE_MAX_BYTES, HOST_MESSAGE_MAX_BYTES, type HostMessage } from '../capture-wire.js'

const LITTLE_ENDIAN = endianness() === 'LE'

export class BadFrame extends Error {}

export async function* readFrames(input: Readable): AsyncIterable<unknown> {
  let buffer: Buffer = Buffer.alloc(0)
  let length: number | null = null
  for await (const chunk of input as AsyncIterable<Buffer>) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      if (length === null) {
        if (buffer.length < 4) break
        length = LITTLE_ENDIAN ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0)
        buffer = buffer.subarray(4)
        if (length > EXTENSION_MESSAGE_MAX_BYTES) throw new BadFrame(`a ${length}-byte frame is over the cap`)
      }
      if (buffer.length < length) break
      const body = buffer.subarray(0, length)
      buffer = buffer.subarray(length)
      length = null
      let message: unknown
      try {
        message = JSON.parse(body.toString('utf8'))
      } catch (error) {
        throw new BadFrame(`a frame is not JSON: ${(error as Error).message}`)
      }
      yield message
    }
  }
}

export class FrameTooLarge extends Error {}

export type FrameWriter = (message: HostMessage) => void

export function frameWriter(output: Writable): FrameWriter {
  return (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    if (body.length + 4 > HOST_MESSAGE_MAX_BYTES) {
      throw new FrameTooLarge(`a ${message.t} message of ${body.length} bytes is over Chrome's 1 MiB cap`)
    }
    const frame = Buffer.allocUnsafe(4 + body.length)
    if (LITTLE_ENDIAN) frame.writeUInt32LE(body.length, 0)
    else frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)
    output.write(frame)
  }
}

export function takeStdout(): Writable {
  const real = process.stdout
  const write = real.write.bind(real) as (chunk: Buffer, callback: (error?: Error | null) => void) => boolean
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
  console.log = console.error
  console.info = console.error
  console.debug = console.error
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      write(chunk, callback)
    },
  })
}
