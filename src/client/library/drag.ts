/** A library item carried by drag, from the drawer to a composer or a canvas.
 *  The item travels as its own type, so a box that takes dropped files is not
 *  handed a URL, and a target can tell while hovering whether it takes it:
 *  `dataTransfer` shows types during a drag and data only on the drop. */

import type { LibraryItemWire } from '../../library-wire.js'

const ITEM_TYPE = 'application/x-ezdesign-library-item'
/** Present too when the item is a still image, which is all a canvas holds. */
const IMAGE_TYPE = 'application/x-ezdesign-library-image'
/** On the root for the length of a drag: frames that are their own documents
 *  would take the drag from the board under them, so they stand aside. */
export const LIBRARY_DRAG_ATTR = 'data-ez-library-drag'

export interface LibraryDragWire {
  id: string
  title: string
  /** Set for a still image: its full-size bytes. */
  image: { url: string; mediaType: string } | null
}

/** What a drag says of an item. Only a still image carries bytes a canvas can hold. */
export function libraryDragWire(item: LibraryItemWire): LibraryDragWire {
  const original = item.original
  const still = item.kind !== 'video' && !!original?.mediaType.startsWith('image/')
  return {
    id: item.id,
    title: item.source.pageTitle || item.note || 'image',
    image: still && original ? { url: original.url, mediaType: original.mediaType } : null,
  }
}

/** Makes a card draggable. `preview` is what follows the pointer. */
export function makeLibraryDraggable(card: HTMLElement, item: LibraryItemWire, preview: () => Element | null): void {
  card.draggable = true
  // Dragged by its thumbnail, the browser would carry the image's own file and
  // URL, and a box that takes dropped files would upload that instead.
  for (const img of card.querySelectorAll('img')) img.draggable = false
  card.addEventListener('dragstart', (e) => {
    const data = e.dataTransfer
    if (!data) return
    const wire = libraryDragWire(item)
    data.effectAllowed = 'copy'
    data.setData(ITEM_TYPE, JSON.stringify(wire))
    if (wire.image) data.setData(IMAGE_TYPE, '')
    const shown = preview()
    if (shown) {
      const box = shown.getBoundingClientRect()
      data.setDragImage(shown, box.width / 2, box.height / 2)
    }
    document.documentElement.toggleAttribute(LIBRARY_DRAG_ATTR, true)
  })
  card.addEventListener('dragend', () => document.documentElement.removeAttribute(LIBRARY_DRAG_ATTR))
}

/** While hovering: whether a library item is being carried, and whether it is a still image. */
export function carriedLibraryItem(e: Pick<DragEvent, 'dataTransfer'>): { image: boolean } | null {
  const types = e.dataTransfer?.types ?? []
  return types.includes(ITEM_TYPE) ? { image: types.includes(IMAGE_TYPE) } : null
}

/** On the drop. */
export function droppedLibraryItem(e: Pick<DragEvent, 'dataTransfer'>): LibraryDragWire | null {
  const raw = e.dataTransfer?.getData(ITEM_TYPE)
  if (!raw) return null
  try {
    const wire = JSON.parse(raw) as Partial<LibraryDragWire>
    return typeof wire.id === 'string' && typeof wire.title === 'string' ? (wire as LibraryDragWire) : null
  } catch {
    return null
  }
}

/** The image's full-size bytes as a file, named for the page it came from. */
export async function libraryImageFile(drag: LibraryDragWire): Promise<File | null> {
  if (!drag.image) return null
  const res = await fetch(drag.image.url)
  if (!res.ok) return null
  const blob = await res.blob()
  const type = drag.image.mediaType || blob.type
  // With an extension, so a title that has a dot of its own keeps all of it.
  const extension = type.split('/')[1]?.split('+')[0] ?? 'png'
  return new File([blob], `${drag.title}.${extension}`, { type })
}
