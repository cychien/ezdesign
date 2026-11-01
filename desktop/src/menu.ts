import { Menu, type MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  toggleSidebar(): void
  addFolder(): void
  reload(): void
  toggleDevTools(): void
}

/** The Edit roles are what make copy and paste work in the shell's composer. */
export function installMenu(actions: MenuActions): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Add Folder…', accelerator: 'CmdOrCtrl+O', click: () => actions.addFolder() },
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
