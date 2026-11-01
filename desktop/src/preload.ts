import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_BRIDGE, DESKTOP_CONTRACT, DESKTOP_IPC, type DesktopBridge, type DesktopLayout } from '../../src/desktop-wire.js'
import { TRAFFIC_LIGHT_ROOM } from './title-bar.js'

const bridge: DesktopBridge = {
  contract: DESKTOP_CONTRACT,
  trafficLightRoom: TRAFFIC_LIGHT_ROOM,
  pickFolder: () => ipcRenderer.invoke(DESKTOP_IPC.pickFolder) as Promise<string | null>,
  pathForFile: (file) => webUtils.getPathForFile(file),
  showProject: (opened) => ipcRenderer.send(DESKTOP_IPC.showProject, opened),
  toggleSidebar: () => ipcRenderer.send(DESKTOP_IPC.toggleSidebar),
  onLayout: (listener) => {
    ipcRenderer.on(DESKTOP_IPC.layout, (_event, layout: DesktopLayout) => listener(layout))
    void (ipcRenderer.invoke(DESKTOP_IPC.layoutNow) as Promise<DesktopLayout>).then(listener)
  },
}

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE, bridge)
