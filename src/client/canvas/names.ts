/** The names the tab strip and the boards are found by: roles and accessible
 *  names for what a person can name, `data-testid` for what they cannot (a frame
 *  on the board, a guide). The DOM code reads them from here and the
 *  verify-ezdesign feature notes quote them, so one list says what a test may
 *  rely on. */

export const TEST_IDS = {
  /** role=tablist */
  tabs: 'ez-tabs',
  /** role=tab, only while a dev server is attached */
  appTab: 'ez-tab-app',
  /** role=tab, `data-canvas-id` */
  canvasTab: 'ez-tab-canvas',
  /** the close button inside a canvas tab */
  closeTab: 'ez-tab-close',
  newCanvas: 'ez-tab-new',
  /** the Canvas menu button */
  canvasMenu: 'ez-canvas-menu',
  /** role=menu */
  canvasMenuList: 'ez-canvas-menu-list',
  /** role=menuitem, `data-canvas-id`, `data-archived` */
  canvasMenuItem: 'ez-canvas-menu-item',
  /** the modal `<dialog>` before a permanent delete */
  confirm: 'ez-canvas-confirm',
  /** role=region, `data-canvas-id`; one per mounted canvas, hidden when inactive */
  board: 'ez-board',
  /** the one transformed element */
  world: 'ez-board-world',
  /** role=group, `data-frame-id`, `aria-selected` */
  frame: 'ez-board-frame',
  /** `data-axis` = x|y */
  guide: 'ez-guide',
  /** the camera controls */
  tools: 'ez-board-tools',
  /** the zoom readout, text like `100%` */
  zoom: 'ez-board-zoom',
} as const

export const LABELS = {
  tabs: '分頁',
  appTab: 'App',
  canvasTab: (name: string) => name,
  closeTab: (name: string) => `關閉 ${name}`,
  newCanvas: '新增 canvas',
  canvasMenu: 'Canvas',
  reopen: (name: string) => `重新開啟 ${name}`,
  delete: (name: string) => `刪除 ${name}`,
  confirmTitle: (name: string) => `永久刪除 "${name}"？`,
  confirmBody: '這個 canvas 的所有 frame 檔案都會被刪除，無法復原。',
  confirmGo: '刪除',
  confirmCancel: '取消',
  board: (name: string) => `canvas ${name}`,
  /** The frame's group and its iframe's `title`, as the device previews name theirs. */
  frame: (title: string, width: number, height: number) => `${title} · ${width}×${height}`,
  zoomIn: '放大',
  zoomOut: '縮小',
  zoomLevel: '縮放比例',
  /** The empty start's canvas, numbered past existing ones. Mirrors the
   *  daemon's default (`UserCanvasPort.create`). */
  untitled: '未命名 canvas',
} as const
