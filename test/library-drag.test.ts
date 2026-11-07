import assert from 'node:assert/strict'
import { test } from 'node:test'
import { carriedLibraryItem, droppedLibraryItem, libraryDragWire } from '../src/client/library/drag.js'
import type { LibraryItemWire } from '../src/library-wire.js'

function item(over: Partial<LibraryItemWire> = {}): LibraryItemWire {
  return {
    id: '01ITEM',
    kind: 'image',
    original: { url: '/__ezdesign/api/library/files/a.png', mediaType: 'image/png', bytes: 10 },
    link: null,
    thumbnail: null,
    dimensions: { width: 1600, height: 1000 },
    source: { pageUrl: 'https://linear.app', pageTitle: 'Linear - Plan and build', mediaUrl: null, capturedAt: 0 },
    tags: [],
    note: '',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

/** A `dataTransfer` as Chrome hands it to a drop target: types always, data only on the drop. */
function transfer(data: Record<string, string>) {
  return { dataTransfer: { types: Object.keys(data), getData: (type: string) => data[type] ?? '' } as unknown as DataTransfer }
}

test('a still image carries its bytes; a video, or a video kept as a link, carries none', () => {
  assert.deepEqual(libraryDragWire(item()), {
    id: '01ITEM',
    title: 'Linear - Plan and build',
    image: { url: '/__ezdesign/api/library/files/a.png', mediaType: 'image/png' },
  })
  assert.equal(libraryDragWire(item({ kind: 'screenshot' })).image?.mediaType, 'image/png')
  assert.equal(libraryDragWire(item({ kind: 'video', original: { url: '/v.mp4', mediaType: 'video/mp4', bytes: 1 } })).image, null)
  assert.equal(libraryDragWire(item({ kind: 'video', original: { url: '/f.png', mediaType: 'image/png', bytes: 1 } })).image, null)
  assert.equal(libraryDragWire(item({ original: null })).image, null)
  assert.equal(libraryDragWire(item({ source: { ...item().source, pageTitle: '' }, note: 'why' })).title, 'why')
})

test('while hovering, a target can tell a library item, and whether a canvas can hold it', () => {
  const image = transfer({ 'application/x-ezdesign-library-item': '{}', 'application/x-ezdesign-library-image': '' })
  const video = transfer({ 'application/x-ezdesign-library-item': '{}' })
  assert.deepEqual(carriedLibraryItem(image), { image: true })
  assert.deepEqual(carriedLibraryItem(video), { image: false })
  assert.equal(carriedLibraryItem(transfer({ Files: '' })), null)
  assert.equal(carriedLibraryItem({ dataTransfer: null }), null)
})

test('on the drop, only a well-formed item is taken', () => {
  const wire = libraryDragWire(item())
  assert.deepEqual(droppedLibraryItem(transfer({ 'application/x-ezdesign-library-item': JSON.stringify(wire) })), wire)
  assert.equal(droppedLibraryItem(transfer({ 'application/x-ezdesign-library-item': 'not json' })), null)
  assert.equal(droppedLibraryItem(transfer({ 'application/x-ezdesign-library-item': '{"id":1}' })), null)
  assert.equal(droppedLibraryItem(transfer({ 'text/plain': 'x' })), null)
})
