import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXTENSION_ID } from '../../src/capture-wire.js'
import type { CaptureId } from '../../src/extension/shared/messages.js'
import { type CaptureOutcome, type CaptureTimeline, SEAM_GLOBAL } from '../../src/extension/shared/seam.js'
import { type Library, openLibrary } from '../../src/library/index.js'

export const REPO = fileURLToPath(new URL('../..', import.meta.url))

export interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: object, sessionId?: string): Promise<T>
  close(): void
}

async function connectCdp(url: string): Promise<Cdp> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error(`cannot reach ${url}`)), { once: true })
  })
  let nextId = 1
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry?.reject(new Error(message.error.message))
    else entry?.resolve(message.result)
  })
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        const caller = new Error(method)
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject: (error) => reject(Object.assign(error, { message: `${method}: ${error.message}`, stack: `${method}: ${error.message}\n${caller.stack?.split('\n').slice(1).join('\n')}` })),
        })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
      }),
    close: () => socket.close(),
  }
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await probe()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(50)
  }
}

export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

export function findChromeForTesting(): string | null {
  if (process.env.EZDESIGN_CFT) return process.env.EZDESIGN_CFT
  for (const cache of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(cache)) continue
    const builds = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const build of builds) {
      const found = [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
      ]
        .map((rel) => join(cache, build, rel))
        .find((path) => existsSync(path))
      if (found) return found
    }
  }
  return null
}

export function findFfmpeg(): string | null {
  for (const cache of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(cache)) continue
    for (const build of readdirSync(cache).filter((name) => name.startsWith('ffmpeg-'))) {
      const found = ['ffmpeg-mac', 'ffmpeg-linux'].map((name) => join(cache, build, name)).find((path) => existsSync(path))
      if (found) return found
    }
  }
  return null
}

export interface Fixture {
  type: string
  body: string | Buffer
  headers?: Record<string, string>
  handle?(req: IncomingMessage, res: ServerResponse): void
}

export interface Harness {
  root: string
  dataDir: string
  profile: string
  evidence: string
  cdp: Cdp
  install: { stdout: string; status: number | null }
  fixtures: { same: string; cross: string; serve(path: string, fixture: Fixture): void; log: string[] }
  inWorker<T>(expression: string): Promise<T>
  openTab(url: string): Promise<Tab>
  evaluate<T>(session: string, expression: string): Promise<T>
  screenshot(session: string, name: string): Promise<string>
  restartWorker(page: Tab): Promise<void>
  library(): Promise<Library>
  installHost(): void
  grantHost(pattern: string): Promise<void>
  dispose(): Promise<void>
}

export interface Tab {
  targetId: string
  session: string
  pressShortcut(): Promise<void>
  saveFromMenu(srcUrl: string, mediaType: 'image' | 'video'): Promise<CaptureId>
  dialog(id: CaptureId): Promise<Dialog>
}

export interface Dialog {
  session: string
  evaluate<T>(expression: string): Promise<T>
  type(text: string): Promise<void>
  press(key: 'Enter' | 'Escape' | 'ArrowDown' | 'ArrowUp' | 'Tab' | 'Backspace', modifiers?: number): Promise<void>
  click(testid: string): Promise<void>
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
} as const

export interface LaunchOptions {
  evidence: string
  seed?(dataDir: string): Promise<void>
  withoutHost?: boolean
}

export async function launch(chrome: string, options: LaunchOptions): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ezdesign-capture-e2e-'))
  const dataDir = join(root, 'data')
  const profile = join(root, 'profile')
  const evidence = options.evidence
  mkdirSync(profile)
  mkdirSync(evidence, { recursive: true })
  const runInstall = () =>
    spawnSync(process.execPath, [join(REPO, 'dist/cli.mjs'), 'extension', 'install', '--user-data-dir', profile], {
      env: { ...process.env, HOME: root, EZDESIGN_DATA_DIR: dataDir, EZDESIGN_NO_UPDATE_CHECK: '1' },
      encoding: 'utf8',
    })
  const install = runInstall()
  writeFileSync(join(evidence, 'install.txt'), `${install.stdout}${install.stderr}exit ${install.status}\n`)
  if (install.status !== 0) throw new Error(`extension install failed:\n${install.stderr}`)
  if (options.withoutHost) rmSync(join(profile, 'NativeMessagingHosts'), { recursive: true, force: true })
  await options.seed?.(dataDir)

  const routes = new Map<string, Fixture>()
  const log: string[] = []
  const server = createServer((req, res) => {
    const host = req.headers.host ?? ''
    log.push(`${req.method} ${host}${req.url} cookie=${req.headers.cookie ?? ''}`)
    const fixture = routes.get(req.url?.split('?')[0] ?? '')
    if (!fixture) return void res.writeHead(404).end()
    if (fixture.handle) return fixture.handle(req, res)
    const body = typeof fixture.body === 'string' ? Buffer.from(fixture.body) : fixture.body
    const headers = { 'content-type': fixture.type, 'cache-control': 'no-store', 'accept-ranges': 'bytes', ...fixture.headers }
    // Media elements seek with Range requests; without them a video stays at 0.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : body.length - Number(range[2])
      const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(end - start + 1) })
      return void res.end(body.subarray(start, end + 1))
    }
    res.writeHead(200, { ...headers, 'content-length': String(body.length) }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const child: ChildProcess = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--load-extension=${join(dataDir, 'extension')}`,
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      'about:blank',
    ],
    { env: { HOME: root }, stdio: 'ignore' },
  )
  const portFile = join(profile, 'DevToolsActivePort')
  const debugPort = await waitFor(
    () => existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n')[0],
    'DevToolsActivePort',
  )
  const version = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as {
    webSocketDebuggerUrl: string
  }
  const cdp = await connectCdp(version.webSocketDebuggerUrl)

  const evaluate = async <T>(session: string, expression: string): Promise<T> => {
    const result = await cdp.send<{
      result: { value: T }
      exceptionDetails?: { exception?: { description?: string }; text: string }
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const targets = async () =>
    (await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets')).targetInfos
  const attach = async (targetId: string) => {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Runtime.enable', {}, sessionId).catch(() => {})
    return sessionId
  }
  const isWorker = (url: string) => url.startsWith(`chrome-extension://${EXTENSION_ID}/`) && url.endsWith('/worker.js')
  const attachWorker = async () => {
    const target = await waitFor(async () => (await targets()).find((t) => t.type === 'service_worker' && isWorker(t.url)), 'the extension service worker')
    const session = await attach(target.targetId)
    await waitFor(() => evaluate<boolean>(session, `typeof ${SEAM_GLOBAL} !== 'undefined'`).catch(() => false), 'the worker to publish its seam')
    return session
  }
  let worker = await attachWorker()

  const inWorker = <T>(expression: string) => evaluate<T>(worker, expression)

  const key = async (session: string, name: keyof typeof KEYS, modifiers = 0) => {
    const k = KEYS[name]
    const text = 'text' in k ? k.text : undefined
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers, text }, session)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers }, session)
  }

  const tabFor = (targetId: string, session: string): Tab => ({
    targetId,
    session,
    async pressShortcut() {
      // Chrome matches extension shortcuts on the native key code: S is 1 on macOS, 39 under X11.
      const base = {
        key: 'S',
        code: 'KeyS',
        windowsVirtualKeyCode: 83,
        nativeVirtualKeyCode: process.platform === 'darwin' ? 1 : 39,
        modifiers: 1 | 8,
      }
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, session)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, session)
      await delay(100)
    },
    async saveFromMenu(srcUrl, mediaType) {
      const page = await evaluate<{ url: string; title: string }>(session, '({ url: location.href, title: document.title })')
      const id = await inWorker<CaptureId | null>(`(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        return __ezCapture.listeners.contextMenuClicked(
          { menuItemId: 'ez-save', mediaType: ${JSON.stringify(mediaType)}, srcUrl: ${JSON.stringify(srcUrl)}, pageUrl: ${JSON.stringify(page.url)}, frameId: 0 },
          { id: tab.id, windowId: tab.windowId, url: ${JSON.stringify(page.url)}, title: ${JSON.stringify(page.title)} },
        )
      })()`)
      check(id, 'the menu click started no capture')
      return id
    },
    async dialog(id) {
      const target = await waitFor(
        async () => (await targets()).find((t) => t.type === 'iframe' && t.url.includes(`/dialog.html#${id}`)),
        'the dialog iframe',
      )
      const dialogSession = await attach(target.targetId)
      await waitFor(
        () => evaluate<boolean>(dialogSession, `document.hasFocus() && document.activeElement?.dataset.testid === 'ez-capture-tag-input'`),
        'the dialog to take focus in its tag field',
      )
      return {
        session: dialogSession,
        evaluate: (expression) => evaluate(dialogSession, expression),
        async type(text) {
          await cdp.send('Input.insertText', { text }, dialogSession)
        },
        press: (name, modifiers) => key(dialogSession, name, modifiers),
        async click(testid) {
          await evaluate(dialogSession, `document.querySelector('[data-testid=${testid}]').click()`)
        },
      }
    },
  })

  return {
    root,
    dataDir,
    profile,
    evidence,
    cdp,
    install: { stdout: install.stdout, status: install.status },
    fixtures: {
      same: `http://127.0.0.1:${port}`,
      cross: `http://localhost:${port}`,
      serve: (path, fixture) => routes.set(path, fixture),
      log,
    },
    inWorker,
    async openTab(url) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url })
      const session = await attach(targetId)
      await cdp.send('Page.enable', {}, session)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, session)
      await waitFor(() => evaluate<boolean>(session, `document.readyState === 'complete'`), `${url} to load`)
      await cdp.send('Target.activateTarget', { targetId })
      return tabFor(targetId, session)
    },
    evaluate,
    async screenshot(session, name) {
      const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, session)
      const path = join(evidence, name)
      writeFileSync(path, Buffer.from(data, 'base64'))
      return path
    },
    async restartWorker(page) {
      await cdp.send('ServiceWorker.enable', {}, page.session).catch(() => {})
      await cdp.send('ServiceWorker.stopAllWorkers', {}, page.session)
      await waitFor(async () => !(await targets()).some((t) => t.type === 'service_worker' && isWorker(t.url)), 'the worker to stop')
      await page.pressShortcut()
      worker = await attachWorker()
    },
    library: () => openLibrary({ dir: join(dataDir, 'library') }),
    installHost() {
      const again = runInstall()
      if (again.status !== 0) throw new Error(`extension install failed:\n${again.stderr}`)
    },
    async grantHost(pattern) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'chrome://extensions/' })
      const session = await attach(targetId)
      await waitFor(() => evaluate<boolean>(session, `typeof chrome?.developerPrivate?.addHostPermission === 'function'`), 'chrome://extensions')
      await evaluate(session, `chrome.developerPrivate.addHostPermission(${JSON.stringify(EXTENSION_ID)}, ${JSON.stringify(pattern)})`)
      await cdp.send('Target.closeTarget', { targetId })
    },
    async dispose() {
      await cdp.send('Browser.close').catch(() => {})
      cdp.close()
      server.closeAllConnections()
      server.close()
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'Chrome to exit', 10_000).catch(() => {})
      spawnSync('pkill', ['-f', profile])
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export type { CaptureOutcome, CaptureTimeline }
