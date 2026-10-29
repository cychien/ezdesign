import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifySource, pickSource } from '../src/extension/shared/streams.js'

test('a playlist or a whole video file is a source; a segment, a page or a data URL is not', () => {
  assert.deepEqual(classifySource('https://video.twimg.com/amplify_video/1/pl/abc.m3u8?tag=29'), {
    url: 'https://video.twimg.com/amplify_video/1/pl/abc.m3u8?tag=29',
    as: 'hls',
  })
  assert.deepEqual(classifySource('https://cdn.test/v/clip.mp4?bytestart=0&byteend=999&sig=k'), {
    url: 'https://cdn.test/v/clip.mp4?sig=k',
    as: 'file',
  })
  assert.equal(classifySource('https://video.twimg.com/amplify_video/1/vid/avc1/0/3000/1280x720/seg.m4s'), null)
  assert.equal(classifySource('https://site.test/watch.mp4.html'), null)
  assert.equal(classifySource('data:video/mp4;base64,AAAA'), null)
  assert.equal(classifySource('not a url'), null)
})

const hls = (url: string, seenAt: number) => ({ url, as: 'hls' as const, seenAt })
const file = (url: string, seenAt: number) => ({ url, as: 'file' as const, seenAt })

const probed = (durations: (number | null)[], masters = durations.map(() => false)) => ({ durations, masters })

test('the source picked is the one as long as the video, a master playlist before the player\'s own, a playlist before a file, the newest first', () => {
  const sources = [hls('https://a.test/new.m3u8', 30), file('https://a.test/same.mp4', 20), hls('https://a.test/old.m3u8', 10), hls('https://a.test/long.m3u8', 40)]
  assert.equal(pickSource(sources, probed([3.2, 3.18, 3.18, 60]), 3.181)?.url, 'https://a.test/new.m3u8')
  assert.equal(pickSource(sources, probed([3.2, 3.18, 3.18, 60], [false, false, true, false]), 3.181)?.url, 'https://a.test/old.m3u8')
  assert.equal(pickSource(sources, probed([null, 3.18, null, 60]), 3.181)?.url, 'https://a.test/same.mp4')
  assert.equal(pickSource(sources, probed([10, 11, 12, 60]), 3.181), null, 'nothing as long as the video is nothing')
  assert.equal(pickSource(sources, probed([10, 11, null, 60]), null)?.url, 'https://a.test/long.m3u8', 'with no length, the newest playlist')
  assert.equal(pickSource([], probed([]), 3), null)
})

test('a long video tolerates a few percent of difference between player and playlist', () => {
  assert.equal(pickSource([hls('https://a.test/p.m3u8', 1)], probed([617.5]), 600)?.url, 'https://a.test/p.m3u8')
  assert.equal(pickSource([hls('https://a.test/p.m3u8', 1)], probed([640]), 600), null)
})
