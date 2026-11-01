import { join } from 'node:path'
import { app, dialog } from 'electron'
import { type AttachedDaemon, type PackageSource, attachDaemon, currentDaemon, homeUrlFor } from '../../src/desktop-host.js'
import { SELF_NODE } from '../../src/self-node.js'
import { type MenuActions, installMenu } from './menu.js'
import { startAutoUpdate } from './updates.js'
import { ProjectWindow } from './window.js'

declare const __EZDESIGN_PACKAGE_VERSION__: string

const WATCH_EVERY_MS = 5_000

app.setName('ezdesign')

function packageSource(): PackageSource {
  if (!app.isPackaged) {
    return { kind: 'checkout', cliEntry: join(app.getAppPath(), '..', 'dist', 'cli.mjs'), version: __EZDESIGN_PACKAGE_VERSION__ }
  }
  return { kind: 'bundled', prefix: join(process.resourcesPath, 'ezdesign'), version: __EZDESIGN_PACKAGE_VERSION__ }
}

let daemon: AttachedDaemon | null = null
let projectWindow: ProjectWindow | null = null
const pendingOpens: string[] = []
let appRunsStopped = false

async function launch(): Promise<void> {
  daemon = await attachDaemon({ source: packageSource(), runtime: SELF_NODE })
  const shown = new ProjectWindow({ preload: join(import.meta.dirname, 'preload.cjs'), homeUrl: daemon.homeUrl })
  projectWindow = shown
  shown.onClosed(() => app.quit())
  const menu: MenuActions = {
    showHome: () => shown.showHome(),
    addFolder: () => void shown.pickFolder().then((path: string | null) => (path ? openFolder(path) : undefined)),
    reload: () => shown.reloadShown(),
    toggleDevTools: () => shown.toggleDevTools(),
    checkForUpdates: () => updates.checkNow(),
    restartToUpdate: () => updates.restartToUpdate(),
    downloadedUpdateVersion: null,
  }
  const updates = startAutoUpdate({
    onReady: (version) => installMenu({ ...menu, downloadedUpdateVersion: version }),
  })
  installMenu(menu)
  for (const path of pendingOpens.splice(0)) await openFolder(path)
  setInterval(() => void watchDaemon(), WATCH_EVERY_MS).unref()
}

async function openFolder(path: string): Promise<void> {
  if (!daemon || !projectWindow) return void pendingOpens.push(path)
  try {
    projectWindow.showProject(await daemon.control.open(path))
  } catch (error) {
    void dialog.showMessageBox({ type: 'warning', message: `沒辦法開啟 ${path}`, detail: (error as Error).message })
  }
}

let offeredToReplaceOlderDaemon = false

async function watchDaemon(): Promise<void> {
  if (!daemon || !projectWindow) return
  const now = await currentDaemon()
  if (now?.speaksContract) {
    if (now.port !== daemon.port) {
      daemon = await attachDaemon({ source: packageSource(), runtime: SELF_NODE })
      projectWindow.rebindHome(daemon.homeUrl)
    }
    return
  }
  if (now && offeredToReplaceOlderDaemon) return
  if (now) {
    offeredToReplaceOlderDaemon = true
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: '另一個較舊的 ezdesign 接手了 daemon',
      detail: '要用這個 app 的版本重新啟動嗎？正在進行的 review 會保留。',
      buttons: ['重新啟動', '稍後'],
      defaultId: 0,
    })
    if (response !== 0) return
  }
  offeredToReplaceOlderDaemon = false
  daemon = await attachDaemon({ source: packageSource(), runtime: SELF_NODE })
  projectWindow.rebindHome(homeUrlFor(daemon.port))
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  void openFolder(path)
})

app.on('before-quit', (event) => {
  if (appRunsStopped || !daemon) return
  event.preventDefault()
  void daemon.control.quit().finally(() => {
    appRunsStopped = true
    app.quit()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('second-instance', () => projectWindow?.focus())

if (!app.requestSingleInstanceLock()) app.exit(0)
else void app.whenReady().then(launch).catch((error: Error) => {
  dialog.showErrorBox('ezdesign 無法啟動', error.message)
  app.exit(1)
})
