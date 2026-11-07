import { execFile } from 'node:child_process'
import { constants, accessSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Router } from 'express'
import {
  FEED_MANIFEST,
  MAC_APP_BUNDLE,
  MAC_APP_ID,
  RELEASES_URL,
  bundleInfo,
  checkBundle,
  downloadVerified,
  parseFeedManifest,
  unpackApp,
  updateFeed,
  zipFor,
} from './mac-app-bundle.js'
import type { MacAppJobWire, MacAppWire } from './mac-app-wire.js'

const run = promisify(execFile)

export interface MacAppPlacement {
  platform: NodeJS.Platform
  /** Where an installed copy is looked for, in order; a new one goes into the first the user can write to. */
  dirs: readonly string[]
  feed: string
  arch(): Promise<string>
  open(app: string): Promise<void>
}

/** Under Rosetta `process.arch` says x64 on Apple silicon; the hardware does not. */
async function machineArch(): Promise<string> {
  try {
    const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])
    return stdout.trim() === '1' ? 'arm64' : 'x64'
  } catch {
    return process.arch
  }
}

export function macAppPlacement(env: NodeJS.ProcessEnv = process.env): MacAppPlacement {
  const only = env.EZDESIGN_APPLICATIONS_DIR?.trim()
  return {
    platform: process.platform,
    dirs: only ? [only] : ['/Applications', join(homedir(), 'Applications')],
    feed: updateFeed(env),
    arch: machineArch,
    open: async (app) => void (await run('/usr/bin/open', [app])),
  }
}

function writable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export class MacAppInstaller {
  private job: MacAppJobWire = { phase: 'idle' }
  private running: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly placement: MacAppPlacement) {}

  /** Called on every step of an install, download progress included. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** What changes when a copy is put in place or thrown away by hand. */
  bundleFiles(): string[] {
    if (this.placement.platform !== 'darwin') return []
    return this.placement.dirs.map((dir) => join(dir, MAC_APP_BUNDLE, 'Contents', 'Info.plist'))
  }

  private setJob(job: MacAppJobWire): void {
    this.job = job
    for (const listener of this.listeners) listener()
  }

  async status(): Promise<MacAppWire> {
    const supported = this.placement.platform === 'darwin'
    return {
      supported,
      installed: supported ? await this.installed() : null,
      job: this.job,
      releasesUrl: RELEASES_URL,
    }
  }

  /** Starts an install unless one is under way; one already installed is only opened. */
  start(): void {
    if (this.running || this.placement.platform !== 'darwin') return
    this.setJob({ phase: 'downloading', received: 0, total: null })
    this.running = this.install()
      .then(
        () => this.setJob({ phase: 'idle' }),
        (error: unknown) => this.setJob({ phase: 'failed', error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        this.running = null
      })
  }

  /** Settles once the install started last has finished, either way. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  async open(): Promise<boolean> {
    const installed = await this.installed()
    if (!installed) return false
    await this.placement.open(installed.path)
    return true
  }

  private async installed(): Promise<{ path: string; version: string } | null> {
    for (const dir of this.placement.dirs) {
      const path = join(dir, MAC_APP_BUNDLE)
      if (!existsSync(path)) continue
      const info = await bundleInfo(path).catch(() => null)
      if (info?.id === MAC_APP_ID) return { path, version: info.version }
    }
    return null
  }

  /** Installed is what was asked for; the shell offers to open it again should this fail. */
  private async openAfterInstall(app: string): Promise<void> {
    await this.placement.open(app).catch(() => {})
  }

  private async install(): Promise<void> {
    const present = await this.installed()
    if (present) return this.openAfterInstall(present.path)
    const into = this.placement.dirs.find(writable)
    if (!into) throw new Error(`cannot write to ${this.placement.dirs.join(' or ')}`)

    const res = await fetch(`${this.placement.feed}/${FEED_MANIFEST}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`the release feed answered ${res.status}`)
    const feed = parseFeedManifest(await res.text())
    const file = zipFor(feed.files, await this.placement.arch())
    if (!file) throw new Error('the release has no build for this Mac')

    const temp = mkdtempSync(join(tmpdir(), 'ezdesign-mac-app-'))
    let staging: string | null = null
    try {
      const zip = join(temp, file.url)
      const total = file.size ?? null
      await downloadVerified(`${this.placement.feed}/${file.url}`, file.sha512, zip, {
        onProgress: (received) => {
          this.setJob({ phase: 'downloading', received, total })
        },
      })
      this.setJob({ phase: 'installing' })
      // Unpacked beside its destination, so moving it in is a rename on one volume.
      staging = mkdtempSync(join(into, '.ezdesign-install-'))
      const app = await unpackApp(zip, staging)
      await checkBundle(app, { id: MAC_APP_ID, version: feed.version })
      const dest = join(into, MAC_APP_BUNDLE)
      if (existsSync(dest)) throw new Error(`${dest} is already there`)
      renameSync(app, dest)
      await this.openAfterInstall(dest)
    } finally {
      rmSync(temp, { recursive: true, force: true })
      if (staging) rmSync(staging, { recursive: true, force: true })
    }
  }
}

/** On the api router, behind `refuseCrossSite`: it writes into the Applications folder. */
export function macAppApiRouter(installer: MacAppInstaller): Router {
  const router = Router()
  router.get('/mac-app', (_req, res, next) => {
    installer.status().then((status) => res.set('cache-control', 'no-store').json(status satisfies MacAppWire), next)
  })
  router.post('/mac-app/install', (_req, res, next) => {
    installer.start()
    installer.status().then((status) => res.json(status satisfies MacAppWire), next)
  })
  router.post('/mac-app/open', (_req, res, next) => {
    installer.open().then((opened) => (opened ? res.status(204).end() : res.status(404).json({ error: 'not installed' })), next)
  })
  return router
}
