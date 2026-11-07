/** What a test may find the library by, beside roles and accessible names. */
export const LIBRARY_TEST_IDS = {
  /** the activity bar's button */
  open: 'ez-library-open',
  view: 'ez-library',
  /** the library beside the page, and the activity bar's small button that opens it */
  drawer: 'ez-library-drawer',
  drawerOpen: 'ez-library-drawer-open',
  drawerClose: 'ez-library-drawer-close',
  search: 'ez-library-search',
  /** role=group of toggle buttons, `aria-pressed` */
  tags: 'ez-library-tags',
  grid: 'ez-library-grid',
  /** one per item, `data-item-id` */
  card: 'ez-library-card',
  /** the item's modal `<dialog>` */
  detail: 'ez-library-detail',
  tagInput: 'ez-library-tag-input',
  note: 'ez-library-note',
  remove: 'ez-library-remove',
  confirm: 'ez-library-confirm',
  /** the empty library's button that opens the install dialog */
  install: 'ez-library-install',
  installDialog: 'ez-library-install-dialog',
  /** the composer's `/library` modal `<dialog>` */
  picker: 'ez-library-picker',
  pickerConfirm: 'ez-library-picker-confirm',
  /** role=status: what became of a paste */
  toast: 'ez-library-toast',
} as const
