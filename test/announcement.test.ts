import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Announcement, currentAnnouncement } from '../src/client/announcement.js'

const item = (id: string, draft?: true): Announcement => ({
  id,
  ...(draft && { draft }),
  media: { src: `/${id}.webp`, alt: id },
  title: id,
  body: id,
})

test('the newest published announcement shows until it is seen', () => {
  const list = [item('canvas'), item('library')]
  assert.equal(currentAnnouncement(list, [], null)?.id, 'canvas')
  assert.equal(currentAnnouncement(list, ['canvas'], null), null)
})

test('an older announcement never comes back once a newer one is seen', () => {
  assert.equal(currentAnnouncement([item('canvas'), item('library')], ['canvas'], null), null)
})

test('a draft is skipped, and shown only when previewed by id', () => {
  const list = [item('next', true), item('canvas')]
  assert.equal(currentAnnouncement(list, [], null)?.id, 'canvas')
  assert.equal(currentAnnouncement(list, ['next', 'canvas'], 'next')?.id, 'next')
  assert.equal(currentAnnouncement(list, [], 'missing'), null)
})

test('nothing to show when every announcement is a draft', () => {
  assert.equal(currentAnnouncement([item('next', true)], [], null), null)
})
