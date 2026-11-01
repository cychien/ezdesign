import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, accessSync, createWriteStream, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** An ad-hoc signed app replaces itself. Electron's own updater cannot: Squirrel.Mac
 *  accepts a new copy only under the running one's Developer ID. */

export interface UpdateFile {
  url: string
  sha512: string
}

/** electron-builder names the Apple silicon zip `-arm64-mac.zip` and the Intel one `-mac.zip`. */
export function zipFor(files: readonly UpdateFile[], arch: string): UpdateFile | null {
  const zips = files.filter((f) => f.url.endsWith('-mac.zip'))
  return zips.find((f) => f.url.endsWith('-arm64-mac.zip') === (arch === 'arm64')) ?? null
}

/** `…/ezdesign.app/Contents/MacOS/ezdesign` → `…/ezdesign.app`. */
export function bundleOf(execPath: string): string | null {
  const bundle = dirname(dirname(dirname(execPath)))
  return bundle.endsWith('.app') ? bundle : null
}

/** A copy run from its disk image, or moved aside by Gatekeeper, cannot be replaced
 *  where it is; nor can one in a folder the user cannot write to. */
export function replaceable(bundle: string, access: (path: string, mode: number) => void = accessSync): boolean {
  if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return false
  try {
    access(dirname(bundle), constants.W_OK)
    access(bundle, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Streams `url` to `dest`, hashing as it goes; a copy whose SHA-512 is not the
 *  release's is never left behind. */
export async function downloadVerified(url: string, sha512: string, dest: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url)
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
  const hash = createHash('sha512')
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  body.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(body, createWriteStream(dest))
  const actual = hash.digest('base64')
  if (actual !== sha512) {
    await run('rm', ['-f', dest])
    throw new Error('the download does not match the release')
  }
}

/** Unzips with `ditto`, which keeps the bundle's symlinks and signature intact. */
export async function unpackApp(zip: string, into: string): Promise<string> {
  await run('ditto', ['-x', '-k', zip, into])
  const apps = readdirSync(into).filter((name) => name.endsWith('.app'))
  if (apps.length !== 1) throw new Error('the update holds no single app')
  return join(into, apps[0]!)
}

/** The new copy is this app, at the version offered, and its signature is whole. */
export async function checkBundle(app: string, expected: { id: string; version: string }): Promise<void> {
  const plist = join(app, 'Contents', 'Info.plist')
  const read = async (key: string) => (await run('plutil', ['-extract', key, 'raw', plist])).stdout.trim()
  if ((await read('CFBundleIdentifier')) !== expected.id) throw new Error('the update is another app')
  if ((await read('CFBundleShortVersionString')) !== expected.version) throw new Error('the update is another version')
  await run('codesign', ['--verify', '--deep', '--strict', app])
}

/** Waits for `pid` to exit, puts `next` where `current` was, and opens it; a
 *  failed move puts the old copy back. The old copy is deleted after the open,
 *  which a 150 MB bundle would otherwise hold up. `env` reaches the relaunched app. */
export const SWAP_SCRIPT = `pid="$1"; current="$2"; next="$3"; shift 3
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
old="$current.replaced-$$"
replaced=
if mv "$current" "$old"; then
  if mv "$next" "$current"; then replaced=1; else mv "$old" "$current"; fi
fi
open "$@" "$current"
if [ -n "$replaced" ]; then rm -rf "$old"; fi`

export function swapAfterExit(opts: { pid: number; current: string; next: string; env: Record<string, string> }): void {
  const envArgs = Object.entries(opts.env).flatMap(([key, value]) => ['--env', `${key}=${value}`])
  spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'ezdesign-update', String(opts.pid), opts.current, opts.next, ...envArgs], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}
