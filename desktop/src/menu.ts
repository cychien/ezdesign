import { Menu, type MenuItemConstructorOptions, app } from 'electron'

export interface MenuActions {
  showHome(): void
  addFolder(): void
  reload(): void
  toggleDevTools(): void
  checkForUpdates(): void
  restartToUpdate(): void
  downloadedUpdateVersion: string | null
}

/** The Edit roles are what make copy and paste work in the shell's composer. */
export function installMenu(actions: MenuActions): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => actions.checkForUpdates() },
        ...(actions.downloadedUpdateVersion
          ? [{ label: `Restart to Update to ${actions.downloadedUpdateVersion}`, click: () => actions.restartToUpdate() }]
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
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => actions.showHome() },
        { label: 'Add Folder…', accelerator: 'Shift+CmdOrCtrl+O', click: () => actions.addFolder() },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
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
