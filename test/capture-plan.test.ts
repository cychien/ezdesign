import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceCrop } from '../src/extension/shared/geometry.js'
import { isRestrictedPage, planAfterRefusal, planCapture, planWithoutRecording, posterSource } from '../src/extension/shared/plan.js'

const tab = { id: 1, windowId: 1, url: 'https://site.test/board' }
const menu = (mediaType: string, srcUrl: string, pageUrl = tab.url) =>
  planCapture({ type: 'menu', click: { mediaType, srcUrl, pageUrl, frameId: 0 }, tab: { ...tab, url: pageUrl } })

test('CX-p3-plan: every capture kind takes the row of the capture plan', () => {
  assert.deepEqual(menu('image', 'https://cdn.other.test/a.jpg'), {
    kind: 'image',
    bytes: { via: 'host-download', url: 'https://cdn.other.test/a.jpg' },
    thumb: { from: 'staged-bytes' },
    preview: 'element-bitmap',
    dialog: 'page',
    region: null,
  })
  assert.deepEqual(menu('image', 'data:image/png;base64,AAAA'), {
    kind: 'image',
    bytes: { via: 'page-read', url: 'data:image/png;base64,AAAA' },
    thumb: { from: 'held-bytes' },
    preview: 'element-bitmap',
    dialog: 'page',
    region: null,
  })
  assert.deepEqual(planAfterRefusal(menu('image', 'https://cdn.other.test/a.jpg')!), {
    kind: 'image',
    bytes: { via: 'worker-fetch', url: 'https://cdn.other.test/a.jpg' },
    thumb: { from: 'held-bytes' },
    preview: 'element-bitmap',
    dialog: 'page',
    region: null,
  })
  assert.deepEqual(menu('video', 'https://cdn.other.test/clip.mp4'), {
    kind: 'video',
    bytes: { via: 'host-download', url: 'https://cdn.other.test/clip.mp4' },
    thumb: { from: 'page-frame' },
    preview: 'element-bitmap',
    dialog: 'page',
    region: null,
  })
  assert.deepEqual(menu('video', 'blob:https://site.test/6f1c'), {
    kind: 'video',
    bytes: { via: 'record' },
    thumb: { from: 'page-frame' },
    preview: 'element-bitmap',
    dialog: 'page',
    region: null,
  })
  assert.deepEqual(planWithoutRecording(menu('video', 'blob:https://site.test/6f1c')!).bytes, { via: 'none' })
  assert.deepEqual(menu('video', 'blob:https://chromewebstore.google.com/6f1c', 'https://chromewebstore.google.com/detail/x')!.bytes, {
    via: 'none',
  })
  assert.deepEqual(menu('image', 'https://cdn.other.test/a.jpg', 'https://chromewebstore.google.com/detail/x'), {
    kind: 'image',
    bytes: { via: 'host-download', url: 'https://cdn.other.test/a.jpg' },
    thumb: { from: 'staged-bytes' },
    preview: 'media-url',
    dialog: 'window',
    region: null,
  })
  assert.equal(menu('audio', 'https://cdn.other.test/a.mp3'), null)
  assert.equal(menu('image', ''), null)
  assert.equal(planAfterRefusal(menu('video', 'https://cdn.other.test/clip.mp4')!).bytes.via, 'host-download', 'a refused video is not fetched again')
})

test('CX-p3-plan: a frame the page cannot hand over is cut from a screenshot', () => {
  const thumb = { webp: '', width: 1, height: 1, source: { width: 1, height: 1 } }
  assert.equal(posterSource({ type: 'encoded', thumb, png: null }), 'frame')
  assert.equal(posterSource({ type: 'tainted' }), 'screenshot')
  assert.equal(posterSource({ type: 'protected' }), 'screenshot')
  assert.equal(posterSource({ type: 'empty' }), 'screenshot')
})

test('restricted pages get the dialog in a window', () => {
  assert.equal(isRestrictedPage('chrome://extensions/'), true)
  assert.equal(isRestrictedPage('https://chromewebstore.google.com/detail/x'), true)
  assert.equal(isRestrictedPage('http://localhost:5173/'), false)
  assert.equal(isRestrictedPage(undefined), false)
})

test('a crop at devicePixelRatio 2 takes twice its size from the screenshot, clamped to it', () => {
  assert.deepEqual(deviceCrop({ x: 10, y: 20, width: 100, height: 50 }, { width: 800, height: 600 }, { width: 1600, height: 1200 }), {
    x: 20,
    y: 40,
    width: 200,
    height: 100,
  })
  assert.deepEqual(deviceCrop({ x: 700, y: 500, width: 200, height: 200 }, { width: 800, height: 600 }, { width: 1600, height: 1200 }), {
    x: 1400,
    y: 1000,
    width: 200,
    height: 200,
  })
})
