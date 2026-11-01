import { app } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

export const FIRST_CHECK_DELAY_MS = 10_000
export const CHECK_EVERY_MS = 4 * 60 * 60_000

export interface AutoUpdate {
  checkNow(): void
  restartToUpdate(): void
}

export function startAutoUpdate(opts: { onReady(version: string): void }): AutoUpdate {
  if (!app.isPackaged) return { checkNow: () => {}, restartToUpdate: () => {} }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => opts.onReady(info.version))
  autoUpdater.on('error', () => {})
  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref()
  setInterval(check, CHECK_EVERY_MS).unref()
  return { checkNow: check, restartToUpdate: () => autoUpdater.quitAndInstall() }
}
