/** Shared by the window, which places the traffic lights, and the preload,
 *  which tells the page; no Electron import, so both can load it. */
export const TRAFFIC_LIGHTS = { x: 18, y: 15 } as const
export const TRAFFIC_LIGHT_ROOM = 88
export const SIDEBAR_WIDTH = 248
/** The project pane's inset from the window's edges while the sidebar is open. */
export const PANE_INSET = 8
export const PANE_RADIUS = 10
/** Before the sidebar page paints: the `--side-ground` that page draws. */
export const WINDOW_GROUND = '#ebe9e2'
/** Before a pane's page paints: the shell's --paper. */
export const PANE_GROUND = '#faf9f6'
/** How long a project just opened may take to load before it is shown anyway. */
export const FIRST_LOAD_WAIT_MS = 1500
