#!/usr/bin/env node
// Drives /element across tabs on the `canvas` seed in its own headless Chrome over
// CDP, because the pick click needs Cmd held inside a cross-origin canvas frame and
// chrome-devtools-axi can neither hold a modifier nor reach into that frame.
// Writes screenshots and log.txt to <outDir>; exit 0 when both directions landed.
// usage: cross-tab.mjs <shellUrl> <outDir>
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [shellUrl, out] = process.argv.slice(2)
const api = shellUrl.replace(/\/__ezdesign\/shell.*/, '/__ezdesign/api')
const profile = mkdtempSync(join(tmpdir(), 'cross-tab-chrome-'))
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=2200,1300', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
const wsUrl = await new Promise((ok, fail) => {
  let buf = ''
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]) })
  setTimeout(() => fail(new Error('chrome did not start')), 15000)
})
const ws = new WebSocket(wsUrl)
await new Promise((ok) => ws.addEventListener('open', ok))
let seq = 0
const waiting = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && waiting.has(msg.id)) {
    const { ok, fail } = waiting.get(msg.id)
    waiting.delete(msg.id)
    msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result)
  }
})
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
  const id = ++seq
  waiting.set(id, { ok, fail })
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const page = (m, p) => send(m, p, sessionId)
await page('Emulation.setDeviceMetricsOverride', { width: 2200, height: 1300, deviceScaleFactor: 1, mobile: false })
await page('Page.enable')
await page('Page.navigate', { url: shellUrl })
const evaluate = async (expression) => {
  const r = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const until = async (expression, what, ms = 8000) => {
  const end = Date.now() + ms
  for (;;) {
    if (await evaluate(expression)) return
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(100)
  }
}
const key = async (key, code, modifiers = 0, text) => {
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, ...(text ? { text } : {}), windowsVirtualKeyCode: key === 'Enter' ? 13 : undefined })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
}
const click = async ({ x, y }, modifiers = 0) => {
  await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers })
  await sleep(80)
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers })
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers })
}
const type = (text) => page('Input.insertText', { text })
/** Key by key, the way a person types: the slash menu listens for keystrokes. */
const typeKeys = async (text) => {
  for (const ch of text) {
    await page('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  }
}
const shot = async (name) => {
  const { data } = await page('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'))
}
const tab = (name) => evaluate(`[...document.querySelectorAll('[role=tab]')].find(t => t.getAttribute('aria-label') === ${JSON.stringify(name)}).click()`)
const appPoint = (selector) => evaluate(`(() => { const f = document.querySelector('.ez-stage iframe'); const r = f.getBoundingClientRect(); const e = f.contentDocument.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + e.x + Math.min(e.width / 2, 40), y: r.y + e.y + e.height / 2 } })()`)
const framePoint = (title, local) => evaluate(`(() => { const b = document.querySelector('.ez-board:not([hidden])'); const f = [...b.querySelectorAll('.ez-board-frame')].find(x => x.getAttribute('aria-label').startsWith(${JSON.stringify(title)} + ' ·')); const r = f.querySelector('iframe').getBoundingClientRect(); const zoom = r.width / parseFloat(f.style.width); return { x: r.x + ${local.x} * zoom, y: r.y + ${local.y} * zoom } })()`)
const appPopup = () => evaluate(`document.querySelector('.ez-stage iframe').contentDocument.querySelector('.ez-popup:not([data-ez-hidden]) .ez-input')?.innerText ?? null`)
const state = async () => (await fetch(`${api}/state`)).json()
const log = []
const say = (line) => { log.push(line); console.log(line) }

try {
  await until(`!!document.querySelector('.ez-stage iframe')?.contentDocument?.querySelector('h1')`, 'the app to render')
  await tab('App')
  await sleep(500)

  // 1. App comment -> /element -> pick on a canvas frame -> back on the App.
  await key('e', 'KeyE', 0, 'e')
  await click(await appPoint('h1'))
  await until(`!!document.querySelector('.ez-stage iframe').contentDocument.querySelector('.ez-popup:not([data-ez-hidden])')`, 'the app popup')
  await type('改成 ')
  await typeKeys('/element')
  await sleep(300)
  await key('Enter', 'Enter', 0, '\r')
  await until(`document.querySelector('.ez-stage iframe').contentDocument.documentElement.hasAttribute('data-ez-pick')`, 'the pick to arm')
  await shot('01-app-picking')
  await tab('首頁探索')
  await sleep(1500)
  await key('!', 'Digit1', 8, '!')
  await sleep(800)
  await shot('02-canvas-while-picking')
  await click(await framePoint('Hero A', { x: 100, y: 112 }), 4)
  await until(`!!document.querySelector('[role=tab][aria-label="App"][aria-selected="true"]')`, 'the App tab to come back', 5000)
  await sleep(600)
  say(`after canvas pick, app popup: ${JSON.stringify(await appPopup())}`)
  await shot('03-back-on-app')
  await type('的樣子')
  await key('Enter', 'Enter', 4, '\r')
  await sleep(800)
  const one = (await state()).annotations.at(-1)
  say(`annotation 1: ${JSON.stringify({ comment: one?.comment, source: one?.anchor.source, frame: one?.anchor.frame ?? null, ref: one?.references?.[0]?.anchor })}`)

  // 2. Canvas comment -> /element -> pick on the App -> back on the canvas.
  await tab('首頁探索')
  await sleep(800)
  await evaluate(`document.querySelector('.ez-board:not([hidden])').focus()`)
  if (!(await evaluate(`document.querySelector('.ez-mode-element').getAttribute('aria-pressed') === 'true'`))) await key('e', 'KeyE', 0, 'e')
  await sleep(300)
  await click(await framePoint('Hero A', { x: 80, y: 186 }))
  await sleep(800)
  await type('換成 ')
  await typeKeys('/element')
  await sleep(300)
  await key('Enter', 'Enter', 0, '\r')
  await sleep(500)
  await shot('04-canvas-picking')
  await tab('App')
  await sleep(800)
  await click(await appPoint('a.btn-primary, button'), 4)
  await until(`!!document.querySelector('[role=tab][aria-label="首頁探索"][aria-selected="true"]')`, 'the canvas tab to come back', 5000)
  await sleep(600)
  await shot('05-back-on-canvas')
  await type('的樣子')
  await key('Enter', 'Enter', 4, '\r')
  await sleep(1200)
  const two = (await state()).annotations.at(-1)
  say(`annotation 2: ${JSON.stringify({ comment: two?.comment, source: two?.anchor.source, frame: two?.anchor.frame ?? null, ref: two?.references?.[0]?.anchor })}`)
  await shot('06-queue')
  await evaluate(`document.querySelector('.ez-note').focus()`)
  await key('Enter', 'Enter', 4, '\r')
  await sleep(1500)
  await shot('07-sent')
} catch (err) {
  say(`FAILED: ${err.message}`)
  await shot('failed').catch(() => {})
  process.exitCode = 1
} finally {
  writeFileSync(join(out, 'log.txt'), log.join('\n'))
  chrome.kill()
  ws.close()
}
