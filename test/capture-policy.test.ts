import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeTag, tagKey, thumbnailSize } from '../src/library/policy.js'

test('tags are trimmed and compared case-insensitively', () => {
  assert.equal(normalizeTag('  Hero   Section '), 'Hero Section')
  assert.equal(normalizeTag('   '), null)
  assert.equal(normalizeTag('a,b'), null)
  assert.equal(normalizeTag('a，b'), null)
  assert.equal(normalizeTag('x'.repeat(64)), 'x'.repeat(64))
  assert.equal(normalizeTag('x'.repeat(65)), null)
  assert.equal(tagKey('Hero'), tagKey(' hero'))
  assert.equal(tagKey('Landing Page'), tagKey('landing  page'))
  assert.equal(tagKey('ＵＩ'), tagKey('ui'))
  assert.notEqual(tagKey('按鈕'), tagKey('按钮'))
})

test('thumbnails keep their aspect, cap the long side at 400 and never upscale', () => {
  assert.deepEqual(thumbnailSize(4000, 3000), { width: 400, height: 300 })
  assert.deepEqual(thumbnailSize(300, 9000), { width: 13, height: 400 })
  assert.deepEqual(thumbnailSize(120, 80), { width: 120, height: 80 })
  assert.deepEqual(thumbnailSize(10_000, 1), { width: 400, height: 1 })
})
