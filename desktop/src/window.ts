import { BaseWindow, type IpcMainEvent, type IpcMainInvokeEvent, WebContentsView, dialog, ipcMain, shell } from 'electron'
import { DESKTOP_IPC, type DesktopLayout } from '../../src/desktop-wire.js'
import type { ProjectOpenedWire } from '../../src/projects/wire.js'
import { type KnownOrigins, type NavigationVerdict, judgeNavigation, judgeWindowOpen } from './navigation.js'
import { PANE_INSET, PANE_RADIUS, SIDEBAR_WIDTH, TRAFFIC_LIGHTS, WINDOW_GROUND } from './title-bar.js'

export interface ProjectWindowOptions {
  preload: string
  homeUrl: string
}

interface ProjectView {
  readonly view: WebContentsView
  /** A session that comes back on another port is the same project: its view
   *  reloads at the new origin instead of a second one appearing. */
  origin: string
}

/** One window: the project sidebar on the left, and on the right one live view
 *  per opened project - exactly one visible - or the empty pane before any.
 *  A hidden view keeps its renderer, so switching back keeps scroll and drafts. */
export class ProjectWindow {
  private readonly window: BaseWindow
  private readonly sidebar: WebContentsView
  private readonly empty: WebContentsView
  private readonly projects = new Map<string, ProjectView>()
  private pane: WebContentsView
  private shownProject: string | null = null
  private sidebarOpen = true
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
      backgroundColor: WINDOW_GROUND,
      show: false,
    })
    this.sidebar = this.makeView()
    this.sidebar.setBackgroundColor(WINDOW_GROUND)
    this.empty = this.makeView()
    this.pane = this.empty
    this.window.contentView.addChildView(this.sidebar)
    this.window.contentView.addChildView(this.empty)
    this.layout()
    this.sidebar.webContents.once('did-finish-load', () => this.window.show())
    void this.sidebar.webContents.loadURL(this.pageUrl('sidebar'))
    void this.empty.webContents.loadURL(this.pageUrl('empty'))
    this.window.on('resize', () => this.layout())

    ipcMain.handle(DESKTOP_IPC.pickFolder, (event) => (this.fromDaemonPageTopFrame(event) ? this.pickFolder() : null))
    ipcMain.handle(DESKTOP_IPC.layoutNow, () => this.currentLayout())
    ipcMain.on(DESKTOP_IPC.showProject, (event, opened: ProjectOpenedWire) => {
      if (this.fromDaemonPageTopFrame(event) && isSessionUrl(opened?.shellUrl)) this.showProject(opened)
    })
    ipcMain.on(DESKTOP_IPC.toggleSidebar, (event) => {
      if (this.fromDaemonPageTopFrame(event)) this.toggleSidebar()
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
    this.shownProject = opened.project
    this.reveal(entry.view)
  }

  toggleSidebar(open = !this.sidebarOpen): void {
    this.sidebarOpen = open
    this.layout()
    this.broadcastLayout()
  }

  /** The daemon was replaced and its control port moved. */
  rebindHome(homeUrl: string): void {
    if (homeUrl === this.homeUrl) return
    this.homeUrl = homeUrl
    void this.sidebar.webContents.loadURL(this.pageUrl('sidebar'))
    void this.empty.webContents.loadURL(this.pageUrl('empty'))
  }

  reloadShown(): void {
    this.pane.webContents.reload()
  }

  toggleDevTools(): void {
    this.pane.webContents.toggleDevTools()
  }

  async pickFolder(): Promise<string | null> {
    const picked = await dialog.showOpenDialog(this.window, { properties: ['openDirectory', 'createDirectory'] })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  }

  private pageUrl(pane: 'sidebar' | 'empty'): string {
    const url = new URL(this.homeUrl)
    url.searchParams.set('pane', pane)
    return url.href
  }

  private reveal(view: WebContentsView): void {
    for (const other of [this.empty, ...[...this.projects.values()].map((p) => p.view)]) other.setVisible(other === view)
    this.pane = view
    this.layout()
    this.broadcastLayout()
    view.webContents.focus()
  }

  private layout(): void {
    const { width, height } = this.window.getContentBounds()
    this.sidebar.setVisible(this.sidebarOpen)
    if (this.sidebarOpen) {
      this.sidebar.setBounds({ x: 0, y: 0, width, height })
      this.pane.setBounds({
        x: SIDEBAR_WIDTH,
        y: PANE_INSET,
        width: width - SIDEBAR_WIDTH - PANE_INSET,
        height: height - 2 * PANE_INSET,
      })
      this.pane.setBorderRadius(PANE_RADIUS)
    } else {
      this.pane.setBounds({ x: 0, y: 0, width, height })
      this.pane.setBorderRadius(0)
    }
  }

  private currentLayout(): DesktopLayout {
    return { sidebar: this.sidebarOpen, shown: this.shownProject }
  }

  private broadcastLayout(): void {
    const layout = this.currentLayout()
    for (const view of [this.sidebar, this.empty, ...[...this.projects.values()].map((p) => p.view)]) {
      view.webContents.send(DESKTOP_IPC.layout, layout)
    }
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
    if (verdict.kind === 'home') this.toggleSidebar(true)
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
