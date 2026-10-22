import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { EXTENSION_ID, HOST_NAME } from '../../src/capture-wire.js'
import type { CaptureId, HostState } from '../../src/extension/shared/messages.js'
import { openLibrary, tagKey } from '../../src/library/index.js'
import { CLIP, makeClip, makeJpeg } from './fixtures.js'
import {
  type CaptureOutcome,
  type CaptureTimeline,
  type Dialog,
  type Harness,
  type LaunchOptions,
  REPO,
  check,
  delay,
  findChromeForTesting,
  findFfmpeg,
  launch,
  waitFor,
} from './harness.js'

const PKG_VERSION = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version

interface Context {
  chrome: string
  evidence: string
  scratch: string
  launch(options?: Omit<LaunchOptions, 'evidence'>): Promise<Harness>
}

type Check = { id: string; name: string; needs?: 'ffmpeg'; run(ctx: Context): Promise<void> }

const sha256 = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
  return null
}

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  return bytes.toString('ascii', 12, 16) === 'IHDR' ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null
}

async function meanDifference(h: Harness, session: string, webp: Buffer, reference: Buffer): Promise<number> {
  return h.evaluate<number>(session, `(async () => {
    const decode = async (b64, type) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }))
    const [a, b] = await Promise.all([decode('${webp.toString('base64')}', 'image/webp'), decode('${reference.toString('base64')}', 'image/png')])
    const pixels = (bitmap) => {
      const canvas = new OffscreenCanvas(a.width, a.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0, a.width, a.height)
      return ctx.getImageData(0, 0, a.width, a.height).data
    }
    const pa = pixels(a)
    const pb = pixels(b)
    let sum = 0
    for (let i = 0; i < pa.length; i += 4) sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])
    return sum / ((pa.length / 4) * 3)
  })()`)
}

let photo: Buffer | null = null
async function thePhoto(h: Harness): Promise<Buffer> {
  if (!photo) {
    const blank = await h.openTab('about:blank')
    photo = await makeJpeg((e) => h.evaluate(blank.session, e), 3000, 2000, 7)
  }
  return photo
}

function servePage(h: Harness, path: string, title: string, body: string): string {
  h.fixtures.serve(path, {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font-family:sans-serif}</style></head><body>${body}</body></html>`,
  })
  return `${h.fixtures.same}${path}`
}

async function settled(h: Harness, id: CaptureId, ms = 20_000): Promise<CaptureOutcome> {
  const outcome = await h.inWorker<CaptureOutcome | 'pending'>(
    `Promise.race([__ezCapture.settled(${JSON.stringify(id)}), new Promise((r) => setTimeout(() => r('pending'), ${ms}))])`,
  )
  check(outcome !== 'pending', `capture ${id} did not settle in ${ms} ms`)
  return outcome
}

async function previewDrawn(dialog: Dialog): Promise<'canvas' | 'img'> {
  return waitFor(
    () =>
      dialog.evaluate<'canvas' | 'img' | null>(`(() => {
        const el = document.querySelector('[data-testid=ez-capture-preview]')
        if (!el || el.closest('[hidden]')) return null
        if (el.tagName === 'CANVAS') return el.width > 1 ? 'canvas' : null
        return el.complete && el.naturalWidth > 0 ? 'img' : null
      })()`),
    'the preview to be drawn',
  )
}

async function animationsSettled(dialog: Dialog): Promise<void> {
  await waitFor(() => dialog.evaluate<boolean>(`document.getAnimations().every((a) => a.playState === 'finished')`), 'animations to finish')
  await delay(100)
}

async function timeline(h: Harness, id: CaptureId): Promise<CaptureTimeline> {
  return h.inWorker<CaptureTimeline>(`__ezCapture.timeline(${JSON.stringify(id)})`)
}

async function items(h: Harness) {
  const library = await h.library()
  try {
    return library.find({ limit: 500 }).items
  } finally {
    library.close()
  }
}

const stagingLeft = (h: Harness) => filesUnder(join(h.dataDir, 'library', 'staging'))

async function seedLibrary(dataDir: string, entries: { tags: string[]; deleted?: boolean }[]): Promise<void> {
  const library = await openLibrary({ dir: join(dataDir, 'library') })
  const gone: string[] = []
  for (const [i, entry] of entries.entries()) {
    const stage = library.stage({ kind: 'image', source: { pageUrl: 'https://seed.test/', pageTitle: 'seed', mediaUrl: null, capturedAt: i } })
    const bytes = Buffer.alloc(64, i % 256)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    bytes.writeUInt32BE(i, 8)
    await stage.write(bytes)
    const { item } = await (await stage.finish()).commit({ tags: entry.tags, note: '' })
    if (entry.deleted) gone.push(item.id)
  }
  library.close()
  const db = new DatabaseSync(join(dataDir, 'library', 'library.db'))
  for (const id of gone) db.prepare('UPDATE items SET deleted_at = 1 WHERE id = ?').run(id)
  db.close()
}

const checks: Check[] = [
  {
    id: 'CX-host-install',
    name: 'a Chrome started without PATH reaches the installed host',
    async run(ctx) {
      const h = await ctx.launch()
      check(h.install.stdout.includes(h.profile), `install names the profile:\n${h.install.stdout}`)
      check(h.install.stdout.includes(`host node: ${process.execPath}`), 'install names the absolute node')
      check(
        h.install.stdout.includes(`chrome://extensions > 開發人員模式 > 載入未封裝項目 > ${join(h.dataDir, 'extension')}`),
        'install names the folder to load',
      )
      const manifest = JSON.parse(readFileSync(join(h.profile, 'NativeMessagingHosts', `${HOST_NAME}.json`), 'utf8'))
      const wrapper = join(h.dataDir, 'native-host', 'ezdesign-native-host')
      check(manifest.path === wrapper, `manifest path ${manifest.path}`)
      check(
        JSON.stringify(manifest.allowed_origins) === '["chrome-extension://bgcgoejgebannhlbgfinbghahicahapb/"]',
        `allowed_origins ${JSON.stringify(manifest.allowed_origins)}`,
      )
      const script = readFileSync(wrapper, 'utf8')
      check(script.includes(`exec '${process.execPath}' '${join(h.dataDir, 'native-host', 'host.mjs')}'`), script)
      const state = await h.inWorker<HostState>('__ezCapture.host({ recheck: true })')
      writeFileSync(join(ctx.evidence, 'host-state.json'), JSON.stringify(state, null, 2))
      check(state.type === 'ready', `host state ${JSON.stringify(state)}`)
      check(state.version === PKG_VERSION, `host version ${state.version}`)
      check(state.libraryDir === join(h.dataDir, 'library'), `library ${state.libraryDir}`)
      const generation = readdirSync(join(h.dataDir, 'extension', 'g'))[0]
      const setup = await h.openTab(`chrome-extension://${EXTENSION_ID}/g/${generation}/setup.html`)
      await waitFor(() => h.evaluate<boolean>(setup.session, `document.querySelector('.state')?.textContent === '已連線'`), 'the setup page to show 已連線')
      await h.screenshot(setup.session, 'setup-connected.png')
    },
  },
  {
    id: 'CX-save-image',
    name: 'a cross-origin image without CORS saves with its tags and note',
    async run(ctx) {
      const h = await ctx.launch()
      const photoBytes = await thePhoto(h)
      h.fixtures.serve('/a.jpg', { type: 'image/jpeg', body: photoBytes })
      const src = `${h.fixtures.cross}/a.jpg`
      const url = servePage(h, '/gallery', 'Gallery 測試', `<img src="${src}" style="width:600px">`)
      const page = await h.openTab(url)
      await page.pressShortcut()
      const id = await page.saveFromMenu(src, 'image')
      const dialog = await page.dialog(id)
      check((await previewDrawn(dialog)) === 'img', 'a cross-origin image previews by its URL')
      await dialog.type('Landing Page')
      await dialog.press('Enter')
      await dialog.type('hero')
      await dialog.press('Enter')
      await dialog.evaluate(`document.querySelector('[data-testid=ez-capture-note]').focus()`)
      await dialog.type('字距好')
      await waitFor(() => dialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-save]').disabled`), 'save to be enabled')
      await animationsSettled(dialog)
      await h.screenshot(page.session, 'CX-save-image-dialog.png')
      await dialog.click('ez-capture-save')
      const outcome = await settled(h, id)
      check(outcome.type === 'saved' && !outcome.merged, `outcome ${JSON.stringify(outcome)}`)
      const saved = await items(h)
      writeFileSync(join(ctx.evidence, 'CX-save-image-item.json'), JSON.stringify(saved, null, 2))
      check(saved.length === 1, `${saved.length} items`)
      const [item] = saved
      check(item!.kind === 'image', `kind ${item!.kind}`)
      check(item!.content.type === 'file' && sha256(readFileSync(item!.content.path)) === sha256(photoBytes), 'blob sha256')
      check(
        JSON.stringify([item!.source.pageUrl, item!.source.pageTitle, item!.source.mediaUrl]) === JSON.stringify([url, 'Gallery 測試', src]),
        `source ${JSON.stringify(item!.source)}`,
      )
      check(JSON.stringify(item!.dimensions) === '{"width":3000,"height":2000}', `dimensions ${JSON.stringify(item!.dimensions)}`)
      check(JSON.stringify(item!.tags) === '["hero","Landing Page"]', `tags ${JSON.stringify(item!.tags)}`)
      check(item!.note === '字距好', `note ${item!.note}`)
      const thumb = item!.thumbnail && webpSize(readFileSync(item!.thumbnail.path))
      check(JSON.stringify(thumb) === '{"width":400,"height":267}', `thumbnail ${JSON.stringify(thumb)}`)
      await waitFor(() => stagingLeft(h).length === 0, 'staging to empty', 5000)
      await waitFor(async () => !(await h.evaluate<boolean>(page.session, `!!document.querySelector('[data-ez-capture]')`)), 'the dialog to leave the page', 5000)
    },
  },

  {
    id: 'CX-tag-suggest',
    name: 'a typed prefix suggests live tags by use count, then key',
    async run(ctx) {
      const seed = [
        { tags: ['card'] },
        { tags: ['card', 'Carousel'] },
        { tags: ['card', 'Carousel', 'CTA'] },
        { tags: ['Carousel', 'CTA', 'dark'] },
        { tags: ['cart', 'dark'] },
        { tags: ['cargo'], deleted: true },
        { tags: ['Card Grid'] },
      ]
      const oracle = (prefix: string, chosen: string[]) => {
        const uses = new Map<string, { name: string; uses: number }>()
        for (const entry of seed) {
          if (entry.deleted) continue
          for (const tag of entry.tags) {
            const key = tagKey(tag)
            const found = uses.get(key) ?? { name: tag, uses: 0 }
            found.uses++
            uses.set(key, found)
          }
        }
        return [...uses]
          .filter(([key]) => key.startsWith(tagKey(prefix)) && !chosen.some((c) => tagKey(c) === key))
          .sort(([ka, a], [kb, b]) => b.uses - a.uses || (ka < kb ? -1 : 1))
          .slice(0, 8)
          .map(([, t]) => t.name)
      }
      const h = await ctx.launch({ seed: (dataDir) => seedLibrary(dataDir, seed) })
      const blank = await h.openTab('about:blank')
      const image = await makeJpeg((e) => h.evaluate(blank.session, e), 800, 600, 3)
      h.fixtures.serve('/b.jpg', { type: 'image/jpeg', body: image })
      const page = await h.openTab(servePage(h, '/board', 'Board', `<img src="${h.fixtures.cross}/b.jpg" width="400">`))
      await page.pressShortcut()
      const id = await page.saveFromMenu(`${h.fixtures.cross}/b.jpg`, 'image')
      const dialog = await page.dialog(id)
      const listed = () =>
        dialog.evaluate<string[]>(`[...document.querySelectorAll('[data-testid=ez-capture-tag-suggestions] [role=option] .name')].map((o) => o.textContent)`)
      await dialog.type('ca')
      const expected = { ca: oracle('ca', []), 'after-first-then-c': oracle('c', [oracle('ca', [])[0]!]) }
      const first = await waitFor(async () => {
        const names = await listed()
        return names.length ? names : null
      }, 'suggestions for ca')
      await animationsSettled(dialog)
      await h.screenshot(page.session, 'CX-tag-suggest-ca.png')
      await dialog.press('ArrowDown')
      await dialog.press('Enter')
      await dialog.type(',')
      await dialog.type('c')
      const second = await waitFor(async () => {
        const names = await listed()
        return names.length && !names.includes(expected.ca[0]!) ? names : null
      }, 'suggestions for c')
      await h.screenshot(page.session, 'CX-tag-suggest-c.png')
      const observed = { ca: first, 'after-first-then-c': second }
      writeFileSync(join(ctx.evidence, 'CX-tag-suggest.expected.json'), JSON.stringify(expected, null, 2))
      writeFileSync(join(ctx.evidence, 'CX-tag-suggest.observed.json'), JSON.stringify(observed, null, 2))
      check(JSON.stringify(observed) === JSON.stringify(expected), `observed ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`)
      const chips = await dialog.evaluate<string[]>(`[...document.querySelectorAll('.chip')].map((c) => c.firstChild.textContent)`)
      check(JSON.stringify(chips) === JSON.stringify([expected.ca[0]]), `chips ${JSON.stringify(chips)}`)
    },
  },
  {
    id: 'CX-video-file',
    name: 'a file video saves its original and a poster from the frame on screen',
    needs: 'ffmpeg',
    async run(ctx) {
      const h = await ctx.launch()
      const blank = await h.openTab('about:blank')
      const clip = await makeClip((e) => h.evaluate(blank.session, e), findFfmpeg()!, ctx.scratch)
      h.fixtures.serve('/clip.webm', { type: 'video/webm', body: clip.webm })
      const src = `${h.fixtures.cross}/clip.webm`
      const page = await h.openTab(
        servePage(h, '/video', 'Video', `<video src="${src}" controls muted width="640" height="360" preload="auto"></video>`),
      )
      await h.evaluate(page.session, `(async () => {
        const v = document.querySelector('video')
        if (v.readyState < 2) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }))
        v.currentTime = 2.0
        await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
      })()`)
      check((await h.evaluate<number>(page.session, `document.querySelector('video').currentTime`)) === 2, 'the video is at 2.0 s')
      await page.pressShortcut()
      const id = await page.saveFromMenu(src, 'video')
      const dialog = await page.dialog(id)
      await previewDrawn(dialog)
      await dialog.type('motion')
      await dialog.press('Enter')
      await waitFor(() => dialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-save]').disabled`), 'save to be enabled')
      await waitFor(() => dialog.evaluate<boolean>(`!!document.querySelector('img[data-testid=ez-capture-preview][src^="data:image/webp"]')`), 'the preview to switch to the decoded frame')
      await animationsSettled(dialog)
      await h.screenshot(page.session, 'CX-video-file-dialog.png')
      await dialog.click('ez-capture-save')
      const outcome = await settled(h, id)
      check(outcome.type === 'saved', `outcome ${JSON.stringify(outcome)}`)
      const [item, ...rest] = await items(h)
      writeFileSync(join(ctx.evidence, 'CX-video-file-item.json'), JSON.stringify(item, null, 2))
      check(item && rest.length === 0, 'one item')
      check(item.kind === 'video', `kind ${item.kind}`)
      check(item.content.type === 'file' && item.content.mediaType === 'video/webm', `content ${JSON.stringify(item.content)}`)
      check(item.content.type === 'file' && sha256(readFileSync(item.content.path)) === sha256(clip.webm), 'blob sha256')
      check(JSON.stringify(item.dimensions) === `{"width":${CLIP.width},"height":${CLIP.height}}`, `dimensions ${JSON.stringify(item.dimensions)}`)
      check(JSON.stringify(item.tags) === '["motion"]', `tags ${JSON.stringify(item.tags)}`)
      const thumb = item.thumbnail && readFileSync(item.thumbnail.path)
      check(thumb && JSON.stringify(webpSize(thumb)) === '{"width":400,"height":225}', 'a 400x225 WebP thumbnail')
      const reference = Buffer.from(
        await h.evaluate<string>(page.session, `(async () => {
          const v = document.createElement('video')
          v.muted = true
          v.src = URL.createObjectURL(await (await fetch('/clip.webm')).blob())
          await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }))
          v.currentTime = 2.0
          await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
          const c = new OffscreenCanvas(v.videoWidth, v.videoHeight)
          c.getContext('2d').drawImage(v, 0, 0)
          const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
          let s = ''
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          return btoa(s)
        })()`),
        'base64',
      )
      writeFileSync(join(ctx.evidence, 'CX-video-file-thumbnail.webp'), thumb)
      writeFileSync(join(ctx.evidence, 'CX-video-file-reference.png'), reference)
      const difference = await meanDifference(h, blank.session, thumb, reference)
      writeFileSync(join(ctx.evidence, 'CX-video-file-frame-difference.txt'), `${difference}\n`)
      check(difference < 8, `the poster differs from the frame at 2.0 s by ${difference.toFixed(2)} of 255`)
    },
  },
  {
    id: 'CX-video-stream',
    name: 'a MediaSource video saves as a link with its time and a full-size frame',
    needs: 'ffmpeg',
    async run(ctx) {
      const h = await ctx.launch()
      const blank = await h.openTab('about:blank')
      const clip = await makeClip((e) => h.evaluate(blank.session, e), findFfmpeg()!, ctx.scratch)
      h.fixtures.serve('/clip.webm', { type: 'video/webm', body: clip.webm })
      const url = servePage(
        h,
        '/stream',
        'Stream',
        `<video muted width="640" height="360"></video><script>
          const v = document.querySelector('video')
          const ms = new MediaSource()
          v.src = URL.createObjectURL(ms)
          ms.addEventListener('sourceopen', async () => {
            const sb = ms.addSourceBuffer('video/webm; codecs="vp8"')
            const data = await (await fetch('/clip.webm')).arrayBuffer()
            sb.addEventListener('updateend', () => { ms.endOfStream(); v.currentTime = 3.5 }, { once: true })
            sb.appendBuffer(data)
          })
          v.addEventListener('seeked', () => (document.body.dataset.ready = '1'), { once: true })
        </script>`,
      )
      const page = await h.openTab(url)
      await waitFor(() => h.evaluate<boolean>(page.session, `document.body.dataset.ready === '1'`), 'the stream to seek')
      const src = await h.evaluate<string>(page.session, `document.querySelector('video').currentSrc`)
      check(src.startsWith('blob:'), `src ${src}`)
      await page.pressShortcut()
      const id = await page.saveFromMenu(src, 'video')
      const dialog = await page.dialog(id)
      check((await previewDrawn(dialog)) === 'canvas', 'a stream previews its current frame')
      const statusLine = await waitFor(async () => {
        const text = await dialog.evaluate<string>(`document.querySelector('[data-testid=ez-capture-status]').textContent`)
        return text || null
      }, 'the status line')
      check(statusLine === '串流影片只會儲存連結、目前時間和畫面', `status ${statusLine}`)
      await waitFor(() => dialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-save]').disabled`), 'save to be enabled')
      await animationsSettled(dialog)
      await h.screenshot(page.session, 'CX-video-stream-dialog.png')
      await dialog.click('ez-capture-save')
      const outcome = await settled(h, id)
      check(outcome.type === 'saved', `outcome ${JSON.stringify(outcome)}`)
      const [item, ...rest] = await items(h)
      writeFileSync(join(ctx.evidence, 'CX-video-stream-item.json'), JSON.stringify(item, null, 2))
      check(item && rest.length === 0, 'one item')
      check(item.kind === 'video' && item.content.type === 'link', `content ${JSON.stringify(item.content)}`)
      if (item.content.type !== 'link') return
      check(item.content.reason === 'stream', `reason ${item.content.reason}`)
      check(Math.abs((item.content.playbackTime ?? -1) - 3.5) <= 0.05, `playbackTime ${item.content.playbackTime}`)
      check(item.source.pageUrl === url && item.source.mediaUrl === null, `source ${JSON.stringify(item.source)}`)
      const frame = item.content.frame && readFileSync(item.content.frame.path)
      check(frame && JSON.stringify(pngSize(frame)) === `{"width":${CLIP.width},"height":${CLIP.height}}`, 'a full-size PNG frame')
      check(item.thumbnail && existsSync(item.thumbnail.path), 'a thumbnail')
      const blobs = filesUnder(join(h.dataDir, 'library', 'blobs'))
      check(blobs.length === 1, `${blobs.length} blobs`)
    },
  },
  {
    id: 'CX-p3-esc-discards',
    name: 'Esc, the overlay, 取消 and closing the tab all leave the library unchanged',
    async run(ctx) {
      const h = await ctx.launch()
      const blank = await h.openTab('about:blank')
      for (const n of [1, 2]) {
        h.fixtures.serve(`/${n}.jpg`, { type: 'image/jpeg', body: await makeJpeg((e) => h.evaluate(blank.session, e), 400, 300, n) })
      }
      const url = servePage(h, '/two', 'Two', `<img src="${h.fixtures.cross}/1.jpg"><img src="${h.fixtures.cross}/2.jpg">`)
      const page = await h.openTab(url)
      await page.pressShortcut()
      const first = await page.saveFromMenu(`${h.fixtures.cross}/1.jpg`, 'image')
      const firstDialog = await page.dialog(first)
      await waitFor(() => firstDialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-save]').disabled`), 'save to be enabled')
      await firstDialog.click('ez-capture-save')
      check((await settled(h, first)).type === 'saved', 'the first save')
      const snapshot = () => JSON.stringify(['blobs', 'thumbs'].map((d) => filesUnder(join(h.dataDir, 'library', d)).sort()))
      const before = snapshot()
      check(JSON.parse(before)[0].length === 1 && JSON.parse(before)[1].length === 1, `one blob and one thumbnail: ${before}`)

      const ways: [string, (dialog: Dialog) => Promise<void>][] = [
        ['Esc', (d) => d.press('Escape')],
        ['the overlay', async () => {
          await h.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 8, y: 8, button: 'left', clickCount: 1 }, page.session)
          await h.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 8, y: 8, button: 'left', clickCount: 1 }, page.session)
        }],
        ['取消', (d) => d.click('ez-capture-cancel')],
      ]
      for (const [how, leave] of ways) {
        await waitFor(async () => !(await h.evaluate<boolean>(page.session, `!!document.querySelector('[data-ez-capture]')`)), 'the last dialog to leave', 5000)
        const id = await page.saveFromMenu(`${h.fixtures.cross}/2.jpg`, 'image')
        const dialog = await page.dialog(id)
        await dialog.type('temp')
        await waitFor(() => dialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-save]').disabled`), 'staging to finish')
        await leave(dialog)
        const outcome = await settled(h, id, 5000)
        check(outcome.type === 'cancelled', `${how}: ${JSON.stringify(outcome)}`)
        await waitFor(async () => !(await h.evaluate<boolean>(page.session, `!!document.querySelector('[data-ez-capture]')`)), `${how}: the dialog to leave`, 5000)
        await waitFor(() => stagingLeft(h).length === 0, `${how}: staging to empty`, 5000)
        check(snapshot() === before, `${how}: the library changed: ${snapshot()}`)
      }

      const id = await page.saveFromMenu(`${h.fixtures.cross}/2.jpg`, 'image')
      await page.dialog(id)
      await h.cdp.send('Target.closeTarget', { targetId: page.targetId })
      const outcome = await settled(h, id, 5000)
      check(outcome.type === 'cancelled', `closing the tab: ${JSON.stringify(outcome)}`)
      await waitFor(() => stagingLeft(h).length === 0, 'staging to empty after the tab closed', 5000)
      check(snapshot() === before, `closing the tab changed the library: ${snapshot()}`)
      check((await items(h)).length === 1, 'still one item')
    },
  },

  {
    id: 'CX-host-missing',
    name: 'with no host the dialog shows the install command and saves nothing; the setup page follows the install',
    async run(ctx) {
      const h = await ctx.launch({ withoutHost: true })
      const blank = await h.openTab('about:blank')
      h.fixtures.serve('/a.jpg', { type: 'image/jpeg', body: await makeJpeg((e) => h.evaluate(blank.session, e), 800, 500, 5) })
      const page = await h.openTab(servePage(h, '/gallery', 'Gallery', `<img src="${h.fixtures.cross}/a.jpg" width="500">`))
      await page.pressShortcut()
      const id = await page.saveFromMenu(`${h.fixtures.cross}/a.jpg`, 'image')
      const dialog = await page.dialog(id)
      const install = await waitFor(() => dialog.evaluate<string | null>(`(() => { const el = document.querySelector('[data-testid=ez-capture-install]'); return el && !el.hidden ? el.querySelector('code').textContent : null })()`), 'the install command')
      check(install === 'npx -y @cychien/ezdesign@latest extension install', `install command ${install}`)
      check(await dialog.evaluate<boolean>(`document.querySelector('[data-testid=ez-capture-save]').disabled`), '儲存 is disabled')
      await animationsSettled(dialog)
      await h.screenshot(page.session, 'CX-host-missing-dialog.png')
      await dialog.click('ez-capture-save')
      await dialog.press('Escape')
      check((await settled(h, id, 5000)).type === 'cancelled', 'the capture ends cancelled')
      check(!existsSync(join(h.dataDir, 'library')), 'nothing was written under the data dir')

      const generation = readdirSync(join(h.dataDir, 'extension', 'g'))[0]
      const setup = await h.openTab(`chrome-extension://${EXTENSION_ID}/g/${generation}/setup.html`)
      await waitFor(() => h.evaluate<boolean>(setup.session, `document.querySelector('.state')?.textContent === '找不到 ezdesign host'`), 'the setup page to show the host missing')
      check((await h.evaluate<string>(setup.session, `document.querySelector('code').textContent`)) === install, 'the setup page shows the same command')
      await h.screenshot(setup.session, 'CX-host-missing-setup-before.png')
      h.installHost()
      await h.evaluate(setup.session, `document.querySelector('button.primary').click()`)
      await waitFor(() => h.evaluate<boolean>(setup.session, `document.querySelector('.state')?.textContent === '已連線'`), 'the setup page to connect after recheck')
      check((await h.evaluate<string>(setup.session, `document.querySelector('dd').textContent`)) === PKG_VERSION, 'the setup page shows the version')
      await h.screenshot(setup.session, 'CX-host-missing-setup-after.png')
    },
  },
  {
    id: 'CX-auth-image',
    name: 'an image the host is refused for is saved with the page cookies once the site is granted',
    async run(ctx) {
      const h = await ctx.launch()
      const blank = await h.openTab('about:blank')
      const secret = await makeJpeg((e) => h.evaluate(blank.session, e), 640, 400, 11)
      const statuses: string[] = []
      h.fixtures.serve('/private.png', {
        type: 'image/jpeg',
        body: secret,
        handle(req, res) {
          const allowed = /(^|; )session=1(;|$)/.test(req.headers.cookie ?? '')
          statuses.push(`${allowed ? 200 : 403} cookie=${req.headers.cookie ?? ''} ua=${(req.headers['user-agent'] ?? '').slice(0, 14)}`)
          if (!allowed) return void res.writeHead(403).end()
          res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(secret.length) }).end(secret)
        },
      })
      h.fixtures.serve('/private', {
        type: 'text/html; charset=utf-8',
        body: `<!doctype html><title>Private</title><img src="/private.png" width="400">`,
        headers: { 'set-cookie': 'session=1; Path=/; SameSite=Lax' },
      })
      const page = await h.openTab(`${h.fixtures.cross}/private`)
      await waitFor(() => h.evaluate<boolean>(page.session, `document.querySelector('img').naturalWidth > 0`), 'the page to show its image')
      await page.pressShortcut()
      const src = `${h.fixtures.cross}/private.png`
      const id = await page.saveFromMenu(src, 'image')
      const dialog = await page.dialog(id)
      check((await previewDrawn(dialog)) === 'canvas', "a same-origin image previews from the page's own pixels")
      const button = await waitFor(() => dialog.evaluate<string | null>(`(() => { const b = document.querySelector('button.grant'); return b && !b.hidden ? b.textContent : null })()`), 'the grant button')
      check(button === `允許讀取 ${h.fixtures.cross}`, `button ${button}`)
      check(await dialog.evaluate<boolean>(`document.querySelector('[data-testid=ez-capture-save]').disabled`), '儲存 waits for the grant')
      await animationsSettled(dialog)
      await h.screenshot(page.session, 'CX-auth-image-refused.png')
      // Chrome's prompt is browser UI CDP cannot click; the same grant made in
      // chrome://extensions > site access makes the request resolve without it.
      await h.grantHost('http://localhost/*')
      await dialog.evaluate(`document.querySelector('button.grant').click()`)
      await waitFor(() => dialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-save]').disabled`), 'save after the grant')
      await dialog.click('ez-capture-save')
      const outcome = await settled(h, id)
      writeFileSync(join(ctx.evidence, 'CX-auth-image-requests.txt'), `${statuses.join('\n')}\n`)
      check(outcome.type === 'saved', `outcome ${JSON.stringify(outcome)}`)
      const [item] = await items(h)
      check(item?.content.type === 'file' && sha256(readFileSync(item.content.path)) === sha256(secret), 'the item holds the served bytes')
      check(statuses.some((s) => s.startsWith('403 cookie= ')), `the host was refused without the cookie: ${statuses.join(' | ')}`)
      check(statuses.at(-1)?.startsWith('200 cookie=session=1'), `the worker's request carried the cookie: ${statuses.join(' | ')}`)
    },
  },
  {
    id: 'CX-dialog',
    name: 'walk: the dialog on a hostile page, narrow, with reduced motion, and on a duplicate (screenshots for review)',
    async run(ctx) {
      const h = await ctx.launch({ seed: (dataDir) => seedLibrary(dataDir, [{ tags: ['card', 'Carousel'] }, { tags: ['card', 'cta'] }, { tags: ['cart'] }]) })
      const blank = await h.openTab('about:blank')
      h.fixtures.serve('/a.jpg', { type: 'image/jpeg', body: await makeJpeg((e) => h.evaluate(blank.session, e), 1600, 1000, 9) })
      const page = await h.openTab(
        servePage(
          h,
          '/hostile',
          'A busy page',
          `<style>
            * { font-family: Georgia, serif !important; letter-spacing: 0.1em !important; box-sizing: content-box !important; }
            html, body { background: #101418 !important; color: #f0f !important; }
            button, input, textarea { all: unset; border: 3px dotted lime !important; font-size: 30px !important; }
            header { position: sticky; top: 0; height: 64px; background: #ff0; z-index: 99999; }
            iframe { opacity: 0.2 !important; transform: rotate(3deg) !important; }
          </style>
          <header>Sticky header</header><p>Words. <button>Their button</button> <input placeholder="their input"></p>
          <img src="${h.fixtures.cross}/a.jpg" width="640">
          <div style="height: 2000px"></div>
          <script>
            window.__keys = 0
            addEventListener('keydown', () => window.__keys++, true)
          </script>`,
        ),
      )
      const src = `${h.fixtures.cross}/a.jpg`
      const open = async () => {
        await page.pressShortcut()
        await h.evaluate(page.session, 'window.__keys = 0')
        const id = await page.saveFromMenu(src, 'image')
        return { id, dialog: await page.dialog(id) }
      }
      const exitTime = async (action: () => Promise<void>) => {
        await h.evaluate(page.session, `window.__gone = 0; new MutationObserver((_, o) => { if (!document.querySelector('[data-ez-capture]')) { window.__gone = performance.now(); o.disconnect() } }).observe(document.documentElement, { childList: true })`)
        const start = await h.evaluate<number>(page.session, 'performance.now()')
        await action()
        return (await waitFor(() => h.evaluate<number>(page.session, 'window.__gone'), 'the dialog to leave', 5000)) - start
      }
      const gone = () => waitFor(async () => !(await h.evaluate<boolean>(page.session, `!!document.querySelector('[data-ez-capture]')`)), 'the dialog to leave', 5000)

      const first = await open()
      await h.screenshot(page.session, 'CX-dialog-1-entrance.png')
      await animationsSettled(first.dialog)
      await h.screenshot(page.session, 'CX-dialog-2-rest.png')
      await first.dialog.type('hero')
      await first.dialog.press('Enter')
      await first.dialog.type('layout,spacing,')
      await first.dialog.evaluate(`document.querySelector('[aria-label="移除標籤 layout"]').click()`)
      await first.dialog.type('ca')
      await waitFor(() => first.dialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-tag-suggestions]').hidden`), 'suggestions')
      await first.dialog.press('ArrowDown')
      await first.dialog.press('ArrowDown')
      await animationsSettled(first.dialog)
      await h.screenshot(page.session, 'CX-dialog-3-suggestions.png')
      await first.dialog.press('Enter')
      await first.dialog.evaluate(`document.querySelector('[data-testid=ez-capture-note]').focus()`)
      await first.dialog.type('第一行\n第二行\n第三行')
      await h.screenshot(page.session, 'CX-dialog-4-filled.png')
      const chips = await first.dialog.evaluate<string[]>(`[...document.querySelectorAll('.chip')].map((c) => c.firstChild.textContent)`)
      check(JSON.stringify(chips) === '["hero","spacing","Carousel"]', `chips ${JSON.stringify(chips)}`)
      await waitFor(() => first.dialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-save]').disabled`), 'save to be enabled')
      const saveExit = await exitTime(() => first.dialog.press('Enter', process.platform === 'darwin' ? 4 : 2))
      check((await settled(h, first.id)).type === 'saved', 'Cmd+Enter saves')
      check(saveExit >= 200 && saveExit < 1000, `the save exit took ${saveExit.toFixed(0)} ms`)
      check((await h.evaluate<number>(page.session, 'window.__keys')) === 0, "the page's key handlers saw the typing")
      await gone()

      const second = await open()
      await animationsSettled(second.dialog)
      const cancelExit = await exitTime(() => second.dialog.press('Escape'))
      check((await settled(h, second.id, 5000)).type === 'cancelled', 'Esc cancels')
      check(cancelExit >= 200 && cancelExit < 600, `the cancel exit took ${cancelExit.toFixed(0)} ms`)
      writeFileSync(join(ctx.evidence, 'CX-dialog-exits.txt'), `save exit ${saveExit.toFixed(0)} ms\ncancel exit ${cancelExit.toFixed(0)} ms\n`)
      await gone()

      await h.cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 720, deviceScaleFactor: 2, mobile: false }, page.session)
      const narrow = await open()
      const status = await waitFor(() => narrow.dialog.evaluate<string>(`document.querySelector('[data-testid=ez-capture-status]').textContent`), 'the duplicate status')
      check(status === '已收藏過', `status ${status}`)
      const prefilled = await narrow.dialog.evaluate<[string[], string]>(`[[...document.querySelectorAll('.chip.locked')].map((c) => c.textContent), document.querySelector('[data-testid=ez-capture-note]').value]`)
      check(JSON.stringify(prefilled) === JSON.stringify([['Carousel', 'hero', 'spacing'], '第一行\n第二行\n第三行']), `prefilled ${JSON.stringify(prefilled)}`)
      const overflow = await narrow.dialog.evaluate<boolean>(`document.querySelector('.card').scrollWidth > document.querySelector('.card').clientWidth`)
      check(!overflow, 'nothing overflows the card at 400 px')
      await animationsSettled(narrow.dialog)
      await h.screenshot(page.session, 'CX-dialog-7-narrow-duplicate.png')
      await narrow.dialog.press('Escape')
      await settled(h, narrow.id, 5000)
      await gone()
      await h.cdp.send('Emulation.clearDeviceMetricsOverride', {}, page.session)

      const reduced = await open()
      await h.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, reduced.dialog.session)
      const animation = await reduced.dialog.evaluate<string>(`getComputedStyle(document.querySelector('.card')).animationName`)
      check(animation === 'fade-in', `reduced motion animates the card with ${animation}`)
      await reduced.dialog.press('Escape')
      await settled(h, reduced.id, 5000)
    },
  },
  {
    id: 'CX-perf-dialog',
    name: 'menu click to preview within 300 ms, confirm to committed within 2 s, from a cold host (p95 of 20)',
    async run(ctx) {
      const tags = Array.from({ length: 200 }, (_, i) => `tag-${String(i).padStart(3, '0')}`)
      const h = await ctx.launch({
        seed: (dataDir) => seedLibrary(dataDir, Array.from({ length: 1000 }, (_, i) => ({ tags: [tags[i % 200]!, tags[(i * 7) % 200]!] }))),
      })
      const photoBytes = await thePhoto(h)
      h.fixtures.serve('/a.jpg', { type: 'image/jpeg', body: photoBytes })
      const page = await h.openTab(servePage(h, '/gallery', 'Gallery', `<img src="${h.fixtures.cross}/a.jpg" style="width:600px">`))
      const src = `${h.fixtures.cross}/a.jpg`
      const runs: { preview: number; commit: number; confirmAfterTrigger: number; beforeDialog: string[] }[] = []
      const hostRunning = () => spawnSync('pgrep', ['-f', join(h.dataDir, 'native-host', 'host.mjs')]).status === 0
      for (let run = 0; run < 20; run++) {
        await h.restartWorker(page)
        await waitFor(() => !hostRunning(), 'the host to exit with the worker', 5000)
        const id = await page.saveFromMenu(src, 'image')
        const dialog = await page.dialog(id)
        const shown = await waitFor(async () => {
          const t = await timeline(h, id)
          return t.previewShown ? t : null
        }, 'the preview')
        await delay(150)
        await waitFor(() => dialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-save]').disabled`), 'save to be enabled')
        await dialog.click('ez-capture-save')
        const outcome = await settled(h, id)
        check(outcome.type === 'saved', `run ${run}: ${JSON.stringify(outcome)}`)
        const t = await timeline(h, id)
        runs.push({
          preview: shown.previewShown! - shown.triggered,
          commit: t.committed! - t.confirmed!,
          confirmAfterTrigger: t.confirmed! - t.triggered,
          beforeDialog: t.beforeDialog,
        })
        await waitFor(async () => !(await h.evaluate<boolean>(page.session, `!!document.querySelector('[data-ez-capture]')`)), 'the dialog to leave', 5000)
      }
      const p = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1]!
      const report = {
        preview: { p50: p(runs.map((r) => r.preview), 0.5), p95: p(runs.map((r) => r.preview), 0.95) },
        commit: { p50: p(runs.map((r) => r.commit), 0.5), p95: p(runs.map((r) => r.commit), 0.95) },
        nativeBeforeDialog: [...new Set(runs.flatMap((r) => r.beforeDialog))],
        runs,
      }
      writeFileSync(join(ctx.evidence, 'CX-perf-dialog.json'), JSON.stringify(report, null, 2))
      console.log(`  preview p50 ${report.preview.p50.toFixed(0)} ms, p95 ${report.preview.p95.toFixed(0)} ms; commit p50 ${report.commit.p50.toFixed(0)} ms, p95 ${report.commit.p95.toFixed(0)} ms`)
      check(report.preview.p95 <= 300, `preview p95 ${report.preview.p95.toFixed(0)} ms is over 300`)
      check(report.commit.p95 <= 2000, `commit p95 ${report.commit.p95.toFixed(0)} ms is over 2000`)
      check(report.nativeBeforeDialog.length === 0, `sent before the dialog: ${report.nativeBeforeDialog.join(', ')}`)
    },
  },
]

function realHomeFootprint(): string {
  const support = join(homedir(), 'Library/Application Support')
  const lines: string[] = []
  if (existsSync(support)) {
    for (const vendor of readdirSync(support)) {
      const stack = [join(support, vendor)]
      for (let depth = 0; depth < 2 && stack.length; depth++) {
        for (const dir of stack.splice(0)) {
          let names: string[] = []
          try {
            names = readdirSync(dir)
          } catch {
            continue
          }
          for (const name of names) {
            const path = join(dir, name)
            if (name === 'NativeMessagingHosts') {
              lines.push(`${path}: ${readdirSync(path).filter((f) => f.startsWith(HOST_NAME)).join(',')}`)
            }
            try {
              if (statSync(path).isDirectory()) stack.push(path)
            } catch {}
          }
        }
      }
    }
  }
  for (const dir of ['native-host', 'extension', 'library']) lines.push(`~/.ezdesign/${dir}: ${existsSync(join(homedir(), '.ezdesign', dir))}`)
  return lines.sort().join('\n')
}

async function main(): Promise<number> {
  const arg = (name: string) => {
    const at = process.argv.indexOf(name)
    return at >= 0 ? process.argv[at + 1] : undefined
  }
  const evidence = arg('--evidence') ?? mkdtempSync(join(tmpdir(), 'ezdesign-capture-evidence-'))
  const only = arg('--only')?.split(',')
  const chrome = findChromeForTesting()
  if (!chrome) {
    console.log('SKIP capture e2e: no Chrome for Testing (install it with `npx playwright install chromium`, or set EZDESIGN_CFT)')
    return 0
  }
  if (!existsSync(join(REPO, 'dist/cli.mjs'))) {
    console.log('FAIL capture e2e: no build; run `npm run build` first')
    return 1
  }
  const scratch = mkdtempSync(join(tmpdir(), 'ezdesign-capture-fixtures-'))
  const footprint = realHomeFootprint()
  let failed = 0
  for (const c of checks) {
    if (only && !only.includes(c.id)) continue
    if (c.needs === 'ffmpeg' && !findFfmpeg()) {
      console.log(`SKIP ${c.id}: ${c.name} (no ffmpeg in Playwright's cache; \`npx playwright install ffmpeg\`)`)
      continue
    }
    const open: Harness[] = []
    const dir = join(evidence, c.id)
    mkdirSync(dir, { recursive: true })
    try {
      await c.run({
        chrome,
        evidence: dir,
        scratch,
        async launch(options = {}) {
          const h = await launch(chrome, { ...options, evidence: dir })
          open.push(h)
          return h
        },
      })
      console.log(`PASS ${c.id}: ${c.name}`)
    } catch (error) {
      failed++
      console.log(`FAIL ${c.id}: ${c.name}\n  ${(error as Error).stack?.split('\n').join('\n  ')}`)
    } finally {
      for (const h of open) await h.dispose()
    }
  }
  const touched = realHomeFootprint() !== footprint
  console.log(`${touched ? 'FAIL' : 'PASS'} the real home is untouched (~/Library/Application Support, ~/.ezdesign)`)
  console.log(`evidence ${evidence}`)
  return failed || touched ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code))
}

