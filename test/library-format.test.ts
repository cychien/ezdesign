import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostOf, playbackText, sourceName } from '../src/client/library/format.js'

test('a stream link says where it stopped as m:ss, or h:mm:ss past the hour', () => {
  assert.equal(playbackText(0), '0:00')
  assert.equal(playbackText(83.9), '1:23')
  assert.equal(playbackText(3599), '59:59')
  assert.equal(playbackText(3600 + 65), '1:01:05')
})

test('sources read the way the detail panel prints them', () => {
  assert.equal(hostOf('https://www.youtube.com/watch?v=x'), 'www.youtube.com')
  assert.equal(hostOf('not a url'), 'not a url')
  assert.equal(sourceName({ pageUrl: 'https://x.com/a', pageTitle: '' }), 'x.com')
  assert.equal(sourceName({ pageUrl: '', pageTitle: '' }), '貼上的圖片')
})
