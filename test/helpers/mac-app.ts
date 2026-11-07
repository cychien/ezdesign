import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** `codesign`, `ditto`, `plutil` and `open` are macOS's own. */
export const macOnly = { skip: process.platform !== 'darwin' }

/** A bundle shaped like the app's, ad-hoc signed as the release is. */
export function fakeApp(dir: string, version: string, id = 'dev.ezdesign.app'): string {
  const app = join(dir, 'ezdesign.app')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>ezdesign</string></dict></plist>`,
  )
  writeFileSync(join(app, 'Contents', 'MacOS', 'ezdesign'), `#!/bin/sh\necho ${version}\n`)
  chmodSync(join(app, 'Contents', 'MacOS', 'ezdesign'), 0o755)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app])
  return app
}

/** The app zipped the way electron-builder ships it. */
export function zipApp(app: string, zip: string): string {
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip])
  return zip
}
