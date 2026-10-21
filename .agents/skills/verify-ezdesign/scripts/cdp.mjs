// A headless Chrome driven over raw CDP, for what chrome-devtools-axi cannot do:
// hold a modifier on a click, reach into a cross-origin canvas frame, or drag a
// pointer through intermediate points (resize handles have no ref).
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function launch(url, { out, width = 2200, height = 1300 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'vz-cdp-chrome-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    `--window-size=${width},${height}`, 'about:blank',
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
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const page = (m, p) => send(m, p, sessionId)
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await page('Page.enable')
  await page('Page.navigate', { url })

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
  const mouse = (type, { x, y }, modifiers = 0) =>
    page('Input.dispatchMouseEvent', { type, x, y, modifiers, ...(type === 'mouseMoved' ? { buttons: 0 } : { button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) })
  const click = async (at, modifiers = 0) => {
    await mouse('mouseMoved', at, modifiers)
    await sleep(80)
    await mouse('mousePressed', at, modifiers)
    await mouse('mouseReleased', at, modifiers)
  }
  /** Press at `from`, move through `steps` points to `to`, and run `during` before release. */
  const drag = async (from, to, { steps = 12, during } = {}) => {
    await mouse('mouseMoved', from)
    await mouse('mousePressed', from)
    for (let i = 1; i <= steps; i++) {
      const at = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }
      await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'left', buttons: 1 })
      await sleep(16)
    }
    if (during) await during()
    await mouse('mouseReleased', to)
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
  const close = () => { chrome.kill(); ws.close() }
  return { page, evaluate, until, key, click, drag, type, typeKeys, shot, close }
}

/** Run `walk` against a fresh Chrome on `shellUrl`, logging to `<out>/log.txt`. */
export async function run(shellUrl, out, walk) {
  const log = []
  const say = (line) => { log.push(line); console.log(line) }
  const b = await launch(shellUrl, { out })
  try {
    await walk(b, say)
  } catch (err) {
    say(`FAILED: ${err.message}`)
    await b.shot('failed').catch(() => {})
    process.exitCode = 1
  } finally {
    writeFileSync(join(out, 'log.txt'), log.join('\n'))
    b.close()
  }
}
