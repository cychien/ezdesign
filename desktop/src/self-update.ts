import { spawn } from 'node:child_process'
import { constants, accessSync } from 'node:fs'
import { dirname } from 'node:path'

/** An ad-hoc signed app replaces itself. Electron's own updater cannot: Squirrel.Mac
 *  accepts a new copy only under the running one's Developer ID. */

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
