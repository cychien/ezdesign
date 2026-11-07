/** What the Mac app and the daemon both do with a released copy of the app: the
 *  app to replace itself, the daemon to install it for a user who has none. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const MAC_APP_ID = 'dev.ezdesign.app'
export const MAC_APP_BUNDLE = 'ezdesign.app'
export const RELEASES_URL = 'https://github.com/cychien/ezdesign/releases/latest'

/** Every asset of the newest release, by name. `EZDESIGN_UPDATE_FEED` points it
 *  at another feed, so a whole update or install can run against a local one. */
export const updateFeed = (env: NodeJS.ProcessEnv = process.env): string =>
  env.EZDESIGN_UPDATE_FEED?.trim() || `${RELEASES_URL}/download`

export const FEED_MANIFEST = 'latest-mac.yml'

export interface UpdateFile {
  url: string
  sha512: string
  size?: number
}

export interface UpdateFeed {
  version: string
  files: UpdateFile[]
}

/** Reads the `latest-mac.yml` electron-builder writes: a version and a list of
 *  files, nothing nested deeper. */
export function parseFeedManifest(text: string): UpdateFeed {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1]
  const list = /^files:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text)?.[1] ?? ''
  const files = list
    .split(/^\s*-\s+/m)
    .slice(1)
    .map((entry) => {
      const field = (key: string) => new RegExp(`^\\s*${key}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, 'm').exec(entry)?.[1]
      const size = Number(field('size'))
      return { url: field('url'), sha512: field('sha512'), ...(Number.isFinite(size) && size > 0 ? { size } : {}) }
    })
    .filter((f): f is UpdateFile => !!f.url && !!f.sha512)
  if (!version || files.length === 0) throw new Error(`${FEED_MANIFEST} names no version or no files`)
  return { version, files }
}

/** electron-builder names the Apple silicon zip `-arm64-mac.zip` and the Intel one `-mac.zip`. */
export function zipFor(files: readonly UpdateFile[], arch: string): UpdateFile | null {
  const zips = files.filter((f) => f.url.endsWith('-mac.zip'))
  return zips.find((f) => f.url.endsWith('-arm64-mac.zip') === (arch === 'arm64')) ?? null
}

/** Streams `url` to `dest`, hashing as it goes; a copy whose SHA-512 is not the
 *  release's is never left behind. */
export async function downloadVerified(
  url: string,
  sha512: string,
  dest: string,
  opts: { fetchImpl?: typeof fetch; onProgress?: (received: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await (opts.fetchImpl ?? fetch)(url, opts.signal ? { signal: opts.signal } : {})
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
  const hash = createHash('sha512')
  let received = 0
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    received += chunk.length
    opts.onProgress?.(received)
  })
  try {
    await pipeline(body, createWriteStream(dest))
  } catch (error) {
    rmSync(dest, { force: true })
    throw error
  }
  if (hash.digest('base64') !== sha512) {
    rmSync(dest, { force: true })
    throw new Error('the download does not match the release')
  }
}

/** Unzips with `ditto`, which keeps the bundle's symlinks and signature intact. */
export async function unpackApp(zip: string, into: string): Promise<string> {
  await run('/usr/bin/ditto', ['-x', '-k', zip, into])
  const apps = readdirSync(into).filter((name) => name.endsWith('.app'))
  if (apps.length !== 1) throw new Error('the download holds no single app')
  return join(into, apps[0]!)
}

export async function bundleInfo(app: string): Promise<{ id: string; version: string }> {
  const plist = join(app, 'Contents', 'Info.plist')
  const read = async (key: string) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', plist])).stdout.trim()
  return { id: await read('CFBundleIdentifier'), version: await read('CFBundleShortVersionString') }
}

/** The new copy is this app, at the version offered, and its signature is whole. */
export async function checkBundle(app: string, expected: { id: string; version: string }): Promise<void> {
  const info = await bundleInfo(app)
  if (info.id !== expected.id) throw new Error('the download is another app')
  if (info.version !== expected.version) throw new Error('the download is another version')
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
}
