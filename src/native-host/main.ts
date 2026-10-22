import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { openLibrary } from '../library/index.js'
import { checkCaller } from './caller.js'
import { downloadInto } from './download.js'
import { frameWriter, readFrames, takeStdout } from './framing.js'
import { createHostSession } from './session.js'

declare const __EZDESIGN_VERSION__: string | undefined
const HOST_VERSION = typeof __EZDESIGN_VERSION__ === 'string' ? __EZDESIGN_VERSION__ : 'dev'

async function run(stdout: Writable): Promise<number> {
  const caller = checkCaller(process.argv)
  if (!caller.ok) {
    console.error(`error: ${caller.reason}`)
    return 1
  }
  const session = createHostSession({
    openLibrary,
    send: frameWriter(stdout),
    drained: async () => {
      if (stdout.writableNeedDrain) await once(stdout, 'drain')
    },
    download: downloadInto,
    hostVersion: HOST_VERSION,
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void session.close().then(() => exit(stdout, 0)))
  }
  const reading = (async () => {
    for await (const raw of readFrames(process.stdin)) session.receive(raw)
    return 0
  })()
  const code = await Promise.race([reading, session.ended])
  await session.close()
  return code
}

/** On macOS a pipe is written asynchronously, so leaving before stdout drains
 *  would drop the last frames. */
async function exit(stdout: Writable, code: number): Promise<never> {
  await new Promise<void>((resolve) => stdout.end(resolve))
  process.exit(code)
}

const stdout = takeStdout()
run(stdout).then(
  (code) => exit(stdout, code),
  (err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    return exit(stdout, 1)
  },
)
