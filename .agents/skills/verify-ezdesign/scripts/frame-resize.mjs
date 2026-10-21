#!/usr/bin/env node
// Resizes Hero A on the `canvas` seed by its handles in its own headless Chrome
// over CDP, because chrome-devtools-axi has no ref for a handle and no raw drag.
// Covers a corner, the opposite corner staying put, a snap with its guide, a
// resize at another zoom, and undo back to the seed. Each rect is checked on the
// board and in layout.json. Writes screenshots and log.txt to <outDir>; exit 0
// when every rect matched.
// usage: frame-resize.mjs <shellUrl> <outDir> <projectDir>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, sleep } from './cdp.mjs'

const [shellUrl, out, project] = process.argv.slice(2)

await run(shellUrl, out, async ({ evaluate, until, key, click, drag, shot }, say) => {
  const card = (title) => `[...document.querySelectorAll('.ez-board:not([hidden]) .ez-board-frame')].find(x => x.getAttribute('aria-label').startsWith(${JSON.stringify(title)} + ' ·'))`
  const zoom = () => evaluate(`(() => { const c = ${card('Hero A')}; return c.getBoundingClientRect().width / parseFloat(c.style.width) })()`)
  const rect = (title) => evaluate(`(() => { const c = ${card(title)}; const [, x, y] = /translate\\((-?[\\d.]+)px, (-?[\\d.]+)px\\)/.exec(c.style.transform); return { x: +x, y: +y, width: parseFloat(c.style.width), height: parseFloat(c.style.height) } })()`)
  const center = (selector) => evaluate(`(() => { const r = ${selector}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  const handle = (h) => center(`${card('Hero A')}.querySelector('.ez-board-handle[data-handle="${h}"]')`)
  const button = (label) => evaluate(`document.querySelector('.ez-board:not([hidden]) [aria-label="${label}"]').click()`)
  const guides = () => evaluate(`document.querySelectorAll('.ez-board:not([hidden]) .ez-guide').length`)
  const saved = async () => {
    const canvas = await evaluate(`document.querySelector('[role=tab][aria-selected="true"]').dataset.tab`)
    const frame = await evaluate(`${card('Hero A')}.dataset.frameId`)
    return JSON.parse(readFileSync(join(project, '.ezdesign/canvases', canvas, 'layout.json'), 'utf8')).rects[frame]
  }
  const expect = async (what, want) => {
    const got = await rect('Hero A')
    const disk = await saved()
    const ok = Object.keys(want).every((k) => got[k] === want[k] && disk[k] === want[k])
    say(`${ok ? 'ok  ' : 'FAIL'} ${what}: board ${JSON.stringify(got)} layout.json ${JSON.stringify(disk)}`)
    if (!ok) throw new Error(`${what}: want ${JSON.stringify(want)}`)
  }
  const resize = async (h, world, opts) => {
    const z = await zoom()
    const from = await handle(h)
    await drag(from, { x: from.x + world.dx * z, y: from.y + world.dy * z }, opts)
    await sleep(600)
  }

  await until(`!!document.querySelector('[role=tab][aria-label="首頁探索"]')`, 'the tab strip')
  await evaluate(`document.querySelector('[role=tab][aria-label="首頁探索"]').click()`)
  await until(`!!(${card('Hero A')})`, 'the board')
  await sleep(1200)
  await click(await center(`${card('Hero A')}.querySelector('.ez-board-frame-head')`))
  await sleep(300)
  say(`handles on a lone selection: ${await evaluate(`${card('Hero A')}.querySelectorAll('.ez-board-handle').length`)}, zoom ${(await zoom()).toFixed(3)}`)
  await shot('01-selected')

  await resize('se', { dx: -300, dy: -200 }, { during: () => shot('02-se-dragging') })
  await expect('se corner -300,-200', { x: 0, y: 0, width: 980, height: 700 })
  await shot('03-se-done')

  await resize('nw', { dx: 100, dy: 50 })
  await expect('nw corner +100,+50 keeps the se corner at 980,700', { x: 100, y: 50, width: 880, height: 650 })

  let seen = 0
  await resize('s', { dx: 0, dy: 142 }, { during: async () => { seen = await guides(); await shot('04-snap-guide') } })
  say(`guides while the bottom edge neared Mobile's: ${seen}`)
  if (seen < 1) throw new Error('no guide drawn')
  await expect('s edge snapped to Mobile bottom 844', { x: 100, y: 50, width: 880, height: 794 })

  await button('放大')
  await button('放大')
  await sleep(400)
  const z = await zoom()
  await resize('e', { dx: 150, dy: 0 })
  await expect(`e edge +150 at zoom ${z.toFixed(3)}`, { x: 100, y: 50, width: 1030, height: 794 })
  await shot('05-zoomed-resize')

  for (let i = 0; i < 4; i++) {
    await key('z', 'KeyZ', 4, 'z')
    await sleep(400)
  }
  await expect('four ⌘Z back to the seed', { x: 0, y: 0, width: 1280, height: 900 })
  await shot('06-undone')
})
