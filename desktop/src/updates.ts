import { app, shell } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

declare const __SIGNED_RELEASE__: boolean

export const FIRST_CHECK_DELAY_MS = 10_000
export const CHECK_EVERY_MS = 4 * 60 * 60_000
export const RELEASES_URL = 'https://github.com/cychien/ezdesign/releases/latest'

export interface AutoUpdate {
  checkNow(): void
  take(): void
}

/** A Developer ID signed app downloads an update and installs it on restart.
 *  An ad-hoc signed one cannot: macOS checks the new copy against the running
 *  one's signature, which only a Developer ID keeps the same across builds, so
 *  it only says a version is out and opens the download page. */
export function startAutoUpdate(opts: { onOffer(version: string, by: 'restart' | 'download'): void }): AutoUpdate {
  if (!app.isPackaged) return { checkNow: () => {}, take: () => {} }
  autoUpdater.autoDownload = __SIGNED_RELEASE__
  autoUpdater.autoInstallOnAppQuit = __SIGNED_RELEASE__
  if (__SIGNED_RELEASE__) autoUpdater.on('update-downloaded', (info) => opts.onOffer(info.version, 'restart'))
  else autoUpdater.on('update-available', (info) => opts.onOffer(info.version, 'download'))
  autoUpdater.on('error', () => {})
  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref()
  setInterval(check, CHECK_EVERY_MS).unref()
  return {
    checkNow: check,
    take: () => (__SIGNED_RELEASE__ ? autoUpdater.quitAndInstall() : void shell.openExternal(RELEASES_URL)),
  }
}
