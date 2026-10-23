import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bytesText, hostOf, playbackText } from '../src/client/library/format.js'

test('a stream link says where it stopped as m:ss, or h:mm:ss past the hour', () => {
  assert.equal(playbackText(0), '0:00')
  assert.equal(playbackText(83.9), '1:23')
  assert.equal(playbackText(3599), '59:59')
  assert.equal(playbackText(3600 + 65), '1:01:05')
})

test('sizes and sources read the way the detail panel prints them', () => {
  assert.equal(bytesText(512), '512 B')
  assert.equal(bytesText(78_000), '76 KB')
  assert.equal(bytesText(5_400_000), '5.1 MB')
  assert.equal(hostOf('https://www.youtube.com/watch?v=x'), 'www.youtube.com')
  assert.equal(hostOf('not a url'), 'not a url')
})
