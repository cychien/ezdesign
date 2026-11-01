import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import electronUpdater, { type UpdateInfo } from 'electron-updater'
import type { DesktopUpdateOffer } from '../../src/desktop-wire.js'
import { bundleOf, checkBundle, downloadVerified, replaceable, swapAfterExit, unpackApp, zipFor } from './self-update.js'

const { autoUpdater } = electronUpdater

declare const __SIGNED_RELEASE__: boolean

export const FIRST_CHECK_DELAY_MS = 10_000
export const CHECK_EVERY_MS = 4 * 60 * 60_000
export const RELEASES_URL = 'https://github.com/cychien/ezdesign/releases/latest'
const APP_ID = 'dev.ezdesign.app'

/** Every asset of the newest release, by name. `EZDESIGN_UPDATE_FEED` points a
 *  build at another feed, so the whole update can be run against a local one. */
const FEED = process.env.EZDESIGN_UPDATE_FEED ?? `${RELEASES_URL}/download`

export interface AutoUpdate {
  checkNow(): void
  take(): void
}

/** A Developer ID signed app lets electron-updater download and install. An
 *  ad-hoc signed one replaces itself (`self-update.ts`) where it can, and
 *  otherwise offers the download page. */
export function startAutoUpdate(opts: { onOffer(offer: DesktopUpdateOffer): void }): AutoUpdate {
  if (!app.isPackaged) return { checkNow: () => {}, take: () => {} }
  let take: () => void = () => void shell.openExternal(RELEASES_URL)
  let preparing: string | null = null

  if (__SIGNED_RELEASE__) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-downloaded', (info) => {
      take = () => autoUpdater.quitAndInstall()
      opts.onOffer({ version: info.version, by: 'restart' })
    })
  } else {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED })
    autoUpdater.on('update-available', (info) => {
      if (preparing === info.version) return
      preparing = info.version
      void prepare(info).then(
        (swap) => {
          take = swap
          opts.onOffer({ version: info.version, by: 'restart' })
        },
        () => {
          preparing = null
          opts.onOffer({ version: info.version, by: 'download' })
        },
      )
    })
  }
  autoUpdater.on('error', () => {})
  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref()
  setInterval(check, CHECK_EVERY_MS).unref()
  return { checkNow: check, take: () => take() }
}

/** Downloads, verifies and unpacks the new copy, and returns what swaps it in. */
async function prepare(info: UpdateInfo): Promise<() => void> {
  const current = bundleOf(process.execPath)
  const file = zipFor(info.files, process.arch)
  if (!current || !replaceable(current) || !file) throw new Error('this copy cannot replace itself')
  const dir = mkdtempSync(join(app.getPath('temp'), 'ezdesign-update-'))
  const zip = join(dir, 'update.zip')
  await downloadVerified(`${FEED}/${file.url}`, file.sha512, zip)
  const next = await unpackApp(zip, join(dir, 'app'))
  await checkBundle(next, { id: APP_ID, version: info.version })
  return () => {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0].startsWith('EZDESIGN_') && !!e[1]))
    swapAfterExit({ pid: process.pid, current, next, env })
    app.quit()
  }
}
