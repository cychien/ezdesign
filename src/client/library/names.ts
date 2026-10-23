/** What a test may find the library by, beside roles and accessible names. */
export const LIBRARY_TEST_IDS = {
  /** the activity bar's button */
  open: 'ez-library-open',
  view: 'ez-library',
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
  /** role=status: what became of a paste */
  toast: 'ez-library-toast',
} as const
