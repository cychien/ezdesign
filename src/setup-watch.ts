/** The install menu's state, kept current for as long as a shell is open. The
 *  browsers' extension records and the app bundles are stat'ed once a second
 *  and read again only when one moved; an install in progress reports itself. */

import { stat } from 'node:fs/promises'
import { type RecordFile, extensionRecordFiles, readExtensionPresence } from './capture-install/index.js'
import { extensionSeenFile, readExtensionSeen } from './capture-seen.js'
import type { MacAppInstaller } from './mac-app.js'
import type { SetupWire } from './setup-wire.js'

export const SETUP_POLL_MS = 1000
/** Download progress arrives per chunk; shells hear of it this often at most. */
export const PROGRESS_EVERY_MS = 250

export interface SetupWatchOptions {
  home: string
  platform: NodeJS.Platform
  /** Where the native host records the extension's greeting. */
  dataDir: string
  macApp: MacAppInstaller
  onChange(setup: SetupWire): void
  pollMs?: number
}

async function fingerprint(paths: readonly string[]): Promise<string> {
  const stamps = await Promise.all(
    paths.map((path) =>
      stat(path).then(
        (info) => `${info.mtimeMs}:${info.size}`,
        () => '-',
      ),
    ),
  )
  return stamps.join('|')
}

export class SetupWatch {
  private current: SetupWire | null = null
  private sent = ''
  private seen = ''
  private holders = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | null = null
  private progressTimer: ReturnType<typeof setTimeout> | undefined
  private files: RecordFile[] = []

  constructor(private readonly options: SetupWatchOptions) {
    options.macApp.onChange(() => this.macAppChanged())
  }

  get setup(): SetupWire | null {
    return this.current
  }

  /** Watches while held; the first holder gets a fresh read straight away. */
  hold(): () => void {
    if (this.holders++ === 0) {
      this.seen = ''
      void this.tick()
      this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? SETUP_POLL_MS)
      this.timer.unref?.()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.holders === 0) clearInterval(this.timer)
    }
  }

  /** Settles once the read under way, if any, has been sent. */
  settled(): Promise<void> {
    return this.ticking ?? Promise.resolve()
  }

  private tick(): Promise<void> {
    this.ticking ??= this.check().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  private async check(): Promise<void> {
    const { home, platform, dataDir, macApp } = this.options
    this.files = await extensionRecordFiles({ home, platform })
    const watched = [...this.files.map((f) => f.path), extensionSeenFile(dataDir), ...macApp.bundleFiles()]
    const now = `${watched.join('\n')}#${await fingerprint(watched)}`
    if (now === this.seen) return
    this.seen = now
    await this.read()
  }

  private async read(): Promise<void> {
    const [extension, macApp] = await Promise.all([
      readExtensionPresence({ files: this.files, greeted: readExtensionSeen(this.options.dataDir) }),
      this.options.macApp.status(),
    ])
    this.publish({ extension, macApp })
  }

  private macAppChanged(): void {
    if (this.holders === 0 || this.progressTimer) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined
      void this.options.macApp.status().then((macApp) => this.current && this.publish({ ...this.current, macApp }))
    }, this.current?.macApp.job.phase === 'downloading' ? PROGRESS_EVERY_MS : 0)
  }

  private publish(setup: SetupWire): void {
    this.current = setup
    const text = JSON.stringify(setup)
    if (text === this.sent) return
    this.sent = text
    this.options.onChange(setup)
  }
}
