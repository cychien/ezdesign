/** Notices a frame document changing on disk, so an edit made with the agent's
 *  own file tools, or any editor, reaches an open shell live.
 *
 *  Only `<canvasId>/frames/<frameId>.html` is reported. `canvas.json` and
 *  `layout.json` are the daemon's alone: an outside edit to them is not read
 *  back, and the daemon's next write replaces it.
 *
 *  `fs.watch` recursive (macOS, Windows, Linux on Node >= 20). Events arrive
 *  duplicated, coalesced and for the daemon's own writes, so they are hints:
 *  each is debounced per file and the owner re-reads and re-hashes. */

import { type FSWatcher, existsSync, watch } from 'node:fs'
import { type CanvasId, type FrameId, asCanvasId, asFrameId } from './types.js'

export const DEBOUNCE_MS = 60

export class FrameFileWatcher {
  private watcher: FSWatcher | null = null
  private readonly pending = new Map<string, NodeJS.Timeout>()

  constructor(
    /** Absolute `<project>/.ezdesign/canvases`. */
    private readonly root: string,
    private readonly onFrameFile: (canvasId: CanvasId, frameId: FrameId) => void,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Idempotent. A root that does not exist yet (no canvas ever made) arms on
   *  the first `start()` after one is. */
  start(): void {
    if (this.watcher || !existsSync(this.root)) return
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, (_event, name) => this.schedule(name))
    } catch (err) {
      this.log(`canvas watcher could not start: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // Never take the daemon down: a watcher that fails is a shell that misses
    // outside edits until the next start, which the next read re-hashes anyway.
    this.watcher.on('error', (err) => {
      this.log(`canvas watcher stopped: ${err.message}`)
      this.stop()
    })
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  /** `<canvasId>/frames/<frameId>.html`, both ids through `asCanvasId` /
   *  `asFrameId`; anything else - temp files, manifests, dotfiles - ignored. */
  private schedule(relative: string | Buffer | null): void {
    if (relative === null) return
    const parts = String(relative).split(/[\\/]/)
    if (parts.length !== 3 || parts[1] !== 'frames') return
    const canvasId = asCanvasId(parts[0])
    const file = /^(.*)\.html$/.exec(parts[2]!)
    const frameId = file ? asFrameId(file[1]) : null
    if (!canvasId || !frameId) return
    const key = `${canvasId}/${frameId}`
    clearTimeout(this.pending.get(key))
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key)
        this.onFrameFile(canvasId, frameId)
      }, DEBOUNCE_MS).unref(),
    )
  }
}
