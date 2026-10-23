import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkFrameHtml,
  frameUrl,
  injectFrameOverlay,
  isFrameHost,
  stampSourceLines,
} from '../src/canvas/frame-document.js'
import type { CanvasId, FrameId } from '../src/canvas/types.js'

const DOC = `<!doctype html>
<html lang="zh">
<head><title>x <b>no</b></title><style>.a > b { }</style></head>
<body>
  <!-- <div>skip</div> -->
  <main class="a"
     id="m">
    <h1>大標題</h1>
    <script>if (a < b) document.write('<p>no</p>')</script>
    <p data-ez-source="keep:1">kept</p><img src=x>
  </main>
</body></html>`

test('every element outside the head is stamped with the line its tag starts on', () => {
  const out = stampSourceLines(DOC, 'f.html')
  assert.match(out, /<body data-ez-source="f\.html:4">/)
  assert.match(out, /<main data-ez-source="f\.html:6" class="a"\n {5}id="m">/)
  assert.match(out, /<h1 data-ez-source="f\.html:8">大標題<\/h1>/)
  assert.match(out, /<img data-ez-source="f\.html:10" src=x>/)
})

test('the head, comments, raw text and stamps already there are left alone', () => {
  const out = stampSourceLines(DOC, 'f.html')
  assert.match(out, /<html lang="zh">/)
  assert.match(out, /<head><title>x <b>no<\/b><\/title><style>\.a > b \{ \}<\/style><\/head>/)
  assert.match(out, /<!-- <div>skip<\/div> -->/)
  assert.match(out, /document\.write\('<p>no<\/p>'\)/)
  assert.match(out, /<p data-ez-source="keep:1">kept<\/p>/)
  assert.equal(stampSourceLines(out, 'f.html'), out, 'stamping twice changes nothing')
})

test('a quoted > inside an attribute does not end the tag', () => {
  assert.equal(
    stampSourceLines('<html><body><a title="a > b" href="#">x</a></body></html>', 'f.html'),
    '<html><body data-ez-source="f.html:1"><a data-ez-source="f.html:1" title="a > b" href="#">x</a></body></html>',
  )
})

test('the relay overlay goes in once, after the head, on the shell origin', () => {
  const config = { assets: '1.2.3', shellOrigin: 'http://127.0.0.1:5000', place: { canvasId: 'c', frameId: 'f' } }
  const once = injectFrameOverlay('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>', config)
  assert.equal(
    once,
    '<!doctype html><html><head><link rel="stylesheet" href="http://127.0.0.1:5000/__ezdesign/overlay.css?v=1.2.3">' +
      '<script defer src="http://127.0.0.1:5000/__ezdesign/overlay.js?v=1.2.3" data-ez-link="relay" data-ez-shell="http://127.0.0.1:5000"></script>' +
      '<meta charset="utf-8"></head><body></body></html>',
  )
  assert.equal(injectFrameOverlay(once, config), once)
  assert.match(injectFrameOverlay('<!doctype html><p>x</p>', config), /^<!doctype html><link /)
})

test('a frame must be a whole document of bounded size', () => {
  assert.deepEqual(checkFrameHtml('   '), { code: 'HTML_EMPTY' })
  assert.deepEqual(checkFrameHtml('<div>fragment</div>'), { code: 'NOT_A_DOCUMENT' })
  assert.equal(checkFrameHtml('<!-- hi -->\n<!DOCTYPE html><html></html>'), null)
  assert.equal(checkFrameHtml('<html lang="en"><body></body></html>'), null)
  const big = `<!doctype html>${'x'.repeat(512 * 1024)}`
  assert.deepEqual(checkFrameHtml(big), { code: 'HTML_TOO_LARGE', bytes: big.length, limit: 512 * 1024 })
})

test('only localhost is the frame host, with or without a port', () => {
  assert.equal(isFrameHost('localhost:5000'), true)
  assert.equal(isFrameHost('LOCALHOST'), true)
  assert.equal(isFrameHost('127.0.0.1:5000'), false)
  assert.equal(isFrameHost('localhost.evil.example:5000'), false)
  assert.equal(isFrameHost(undefined), false)
  assert.equal(
    frameUrl('http://localhost:5000', 'aaaaaaaaaaaa' as CanvasId, 'bbbbbbbbbbbb' as FrameId, 'h1'),
    'http://localhost:5000/__ezdesign/frames/aaaaaaaaaaaa/bbbbbbbbbbbb?rev=h1',
  )
})
