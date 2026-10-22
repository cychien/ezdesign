import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { endianness } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ALLOWED_ORIGINS } from '../../src/capture-wire.js'

export const HOST_SRC = fileURLToPath(new URL('../../src/native-host/main.ts', import.meta.url))
const LE = endianness() === 'LE'

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  if (LE) head.writeUInt32LE(body.length)
  else head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

export function decodeFrames(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = []
  let at = 0
  while (buffer.length - at >= 4) {
    const length = LE ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at)
    if (buffer.length - at - 4 < length) break
    messages.push(JSON.parse(buffer.subarray(at + 4, at + 4 + length).toString('utf8')))
    at += 4 + length
  }
  return { messages, rest: buffer.subarray(at) }
}

export interface HostProcess {
  child: ChildProcessWithoutNullStreams
  send(message: unknown): void
  next(match: (message: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>
  readonly frames: { message: Record<string, unknown>; bytes: number }[]
  readonly stderr: () => string
  exited: Promise<number | null>
}

export function spawnHost(options: { dataDir: string; origin?: string; env?: NodeJS.ProcessEnv }): HostProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', HOST_SRC, options.origin ?? ALLOWED_ORIGINS[0]!], {
    env: { ...process.env, ...options.env, EZDESIGN_DATA_DIR: options.dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames: { message: Record<string, unknown>; bytes: number }[] = []
  const waiters: {
    match: (m: Record<string, unknown>) => boolean
    resolve(m: Record<string, unknown>): void
    reject(error: Error): void
  }[] = []
  let pending: Buffer = Buffer.alloc(0)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
  child.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    const { messages, rest } = decodeFrames(pending)
    pending = rest
    for (const raw of messages) {
      const message = raw as Record<string, unknown>
      frames.push({ message, bytes: Buffer.byteLength(JSON.stringify(raw)) })
      const at = waiters.findIndex((w) => w.match(message))
      if (at >= 0) waiters.splice(at, 1)[0]!.resolve(message)
    }
  })
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      for (const w of waiters.splice(0)) w.reject(new Error(`host exited (${code}) first; stderr: ${stderr}`))
      resolve(code)
    }),
  )
  return {
    child,
    frames,
    stderr: () => stderr,
    exited,
    send: (message) => child.stdin.write(encodeFrame(message)),
    next(match, ms = 10_000) {
      const seen = frames.find((f) => match(f.message))
      if (seen) return Promise.resolve(seen.message)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no matching host message in ${ms} ms; stderr: ${stderr}`)), ms)
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)), reject: (e) => (clearTimeout(timer), reject(e)) })
      })
    },
  }
}
