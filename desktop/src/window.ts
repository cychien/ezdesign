import { BaseWindow, type IpcMainEvent, type IpcMainInvokeEvent, WebContentsView, dialog, ipcMain, shell } from 'electron'
import { DESKTOP_IPC } from '../../src/desktop-wire.js'
import type { ProjectOpenedWire } from '../../src/projects/wire.js'
import { type KnownOrigins, type NavigationVerdict, judgeNavigation, judgeWindowOpen } from './navigation.js'
import { TRAFFIC_LIGHTS } from './title-bar.js'

export interface ProjectWindowOptions {
  preload: string
  homeUrl: string
}

interface ProjectView {
  readonly view: WebContentsView
  origin: string
}

export class ProjectWindow {
  private readonly window: BaseWindow
  private readonly home: WebContentsView
  private readonly projects = new Map<string, ProjectView>()
  private shown: WebContentsView
  private homeUrl: string

  constructor(private readonly opts: ProjectWindowOptions) {
    this.homeUrl = opts.homeUrl
    this.window = new BaseWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      title: 'ezdesign',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: TRAFFIC_LIGHTS,
      backgroundColor: '#faf9f6',
      show: false,
    })
    this.home = this.makeView()
    this.shown = this.home
    this.window.contentView.addChildView(this.home)
    this.layout()
    this.home.webContents.once('did-finish-load', () => this.window.show())
    void this.home.webContents.loadURL(this.homeUrl)
    this.window.on('resize', () => this.layout())

    ipcMain.handle(DESKTOP_IPC.pickFolder, (event) => (this.fromDaemonPageTopFrame(event) ? this.pickFolder() : null))
    ipcMain.on(DESKTOP_IPC.showProject, (event, opened: ProjectOpenedWire) => {
      if (this.fromDaemonPageTopFrame(event) && isSessionUrl(opened?.shellUrl)) this.showProject(opened)
    })
    ipcMain.on(DESKTOP_IPC.showHome, (event) => {
      if (this.fromDaemonPageTopFrame(event)) this.showHome()
    })
  }

  focus(): void {
    if (this.window.isMinimized()) this.window.restore()
    this.window.focus()
  }

  onClosed(listener: () => void): void {
    this.window.on('closed', listener)
  }

  showProject(opened: ProjectOpenedWire): void {
    const origin = new URL(opened.shellUrl).origin
    let entry = this.projects.get(opened.project)
    if (!entry) {
      const view = this.makeView()
      this.window.contentView.addChildView(view)
      void view.webContents.loadURL(opened.shellUrl)
      entry = { view, origin }
      this.projects.set(opened.project, entry)
    } else if (entry.origin !== origin) {
      entry.origin = origin
      void entry.view.webContents.loadURL(opened.shellUrl)
    }
    this.reveal(entry.view)
  }

  showHome(): void {
    this.reveal(this.home)
  }

  rebindHome(homeUrl: string): void {
    if (homeUrl === this.homeUrl) return
    this.homeUrl = homeUrl
    void this.home.webContents.loadURL(homeUrl)
  }

  reloadShown(): void {
    this.shown.webContents.reload()
  }

  toggleDevTools(): void {
    this.shown.webContents.toggleDevTools()
  }

  async pickFolder(): Promise<string | null> {
    const picked = await dialog.showOpenDialog(this.window, { properties: ['openDirectory', 'createDirectory'] })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  }

  private reveal(view: WebContentsView): void {
    for (const other of [this.home, ...[...this.projects.values()].map((p) => p.view)]) other.setVisible(other === view)
    this.shown = view
    this.layout()
    view.webContents.focus()
  }

  private layout(): void {
    const { width, height } = this.window.getContentBounds()
    this.shown.setBounds({ x: 0, y: 0, width, height })
  }

  private fromDaemonPageTopFrame(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    if (event.senderFrame !== event.sender.mainFrame) return false
    const origin = URL.parse(event.sender.getURL())?.origin
    const known = this.known()
    return !!origin && (origin === known.home || known.isSession(origin))
  }

  private makeView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { preload: this.opts.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const contents = view.webContents
    contents.on('will-navigate', (event) => {
      this.apply(judgeNavigation(contents.getURL(), event.url, this.known()), () => event.preventDefault())
    })
    contents.setWindowOpenHandler(({ url }) => {
      this.apply(judgeWindowOpen(url, this.known()), () => {})
      return { action: 'deny' }
    })
    return view
  }

  private apply(verdict: NavigationVerdict, cancel: () => void): void {
    if (verdict.kind === 'allow') return
    cancel()
    if (verdict.kind === 'home') this.showHome()
    if (verdict.kind === 'external') void shell.openExternal(verdict.url)
  }

  private known(): KnownOrigins {
    const sessions = new Set([...this.projects.values()].map((p) => p.origin))
    return { home: new URL(this.homeUrl).origin, isSession: (origin) => sessions.has(origin) }
  }
}

function isSessionUrl(url: unknown): url is string {
  const parsed = typeof url === 'string' ? URL.parse(url) : null
  return !!parsed && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
}
