import { Menu, type MenuItemConstructorOptions, app } from 'electron'

export interface MenuActions {
  toggleSidebar(): void
  addFolder(): void
  reload(): void
  toggleDevTools(): void
  checkForUpdates(): void
  takeUpdate(): void
  /** A version waiting: installed on restart, or, in an ad-hoc signed app, downloaded by hand. */
  update: { version: string; by: 'restart' | 'download' } | null
}

/** The Edit roles are what make copy and paste work in the shell's composer. */
export function installMenu(actions: MenuActions): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => actions.checkForUpdates() },
        ...(actions.update
          ? [
              {
                label:
                  actions.update.by === 'restart'
                    ? `Restart to Update to ${actions.update.version}`
                    : `Download ezdesign ${actions.update.version}…`,
                click: () => actions.takeUpdate(),
              },
            ]
          : []),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Add Project…', accelerator: 'CmdOrCtrl+O', click: () => actions.addFolder() },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'Ctrl+Cmd+S', click: () => actions.toggleSidebar() },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => actions.reload() },
        { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => actions.toggleDevTools() },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
