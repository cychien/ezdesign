/** Skips when no Chrome for Testing is found: branded Chrome 137+ ignores
 *  `--load-extension`. */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXTENSION_ID, HOST_NAME } from '../../src/capture-wire.js'
import type { HostState } from '../../src/extension/shared/messages.js'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const PKG_VERSION = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version

export interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: object, sessionId?: string): Promise<T>
  on(method: string, listener: (params: Record<string, unknown>, sessionId?: string) => void): void
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
  const listeners = new Map<string, ((params: Record<string, unknown>, sessionId?: string) => void)[]>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number
      result?: unknown
      error?: { message: string }
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry?.reject(new Error(message.error.message))
      else entry?.resolve(message.result)
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId)
    }
  })
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
      }),
    on: (method, listener) => listeners.set(method, [...(listeners.get(method) ?? []), listener]),
    close: () => socket.close(),
  }
}

export interface Harness {
  root: string
  dataDir: string
  profile: string
  evidence: string
  cdp: Cdp
  install: { stdout: string; status: number | null }
  inWorker<T>(expression: string): Promise<T>
  openTab(url: string): Promise<string>
  evaluate<T>(session: string, expression: string): Promise<T>
  screenshot(session: string, name: string): Promise<string>
  dispose(): Promise<void>
}

export type Check = { name: string; run(h: Harness): Promise<void> }

export function findChromeForTesting(): string | null {
  if (process.env.EZDESIGN_CFT) return process.env.EZDESIGN_CFT
  const caches = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]
  for (const cache of caches) {
    if (!existsSync(cache)) continue
    const builds = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const build of builds) {
      const candidates = [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
      ].map((rel) => join(cache, build, rel))
      const found = candidates.find((path) => existsSync(path))
      if (found) return found
    }
  }
  return null
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await probe()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(100)
  }
}

export async function launch(chrome: string, evidence: string): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ezdesign-capture-e2e-'))
  const dataDir = join(root, 'data')
  const profile = join(root, 'profile')
  mkdirSync(profile)
  mkdirSync(evidence, { recursive: true })
  const install = spawnSync(process.execPath, [join(REPO, 'dist/cli.mjs'), 'extension', 'install', '--user-data-dir', profile], {
    env: { ...process.env, HOME: root, EZDESIGN_DATA_DIR: dataDir, EZDESIGN_NO_UPDATE_CHECK: '1', EZDESIGN_CAPTURE: '1' },
    encoding: 'utf8',
  })
  writeFileSync(join(evidence, 'install.txt'), `${install.stdout}${install.stderr}exit ${install.status}\n`)
  if (install.status !== 0) throw new Error(`extension install failed:\n${install.stderr}`)

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
      'about:blank',
    ],
    { env: { HOME: root }, stdio: 'ignore' },
  )
  const portFile = join(profile, 'DevToolsActivePort')
  const port = await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n')[0], 'DevToolsActivePort')
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
  const cdp = await connectCdp(version.webSocketDebuggerUrl)

  const workerUrl = (url: string) => url.startsWith(`chrome-extension://${EXTENSION_ID}/`) && url.endsWith('/worker.js')
  const workerTarget = await waitFor(async () => {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets')
    return targetInfos.find((t) => t.type === 'service_worker' && workerUrl(t.url))
  }, 'the extension service worker')
  const { sessionId: worker } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId: workerTarget.targetId,
    flatten: true,
  })

  const evaluate = async <T>(session: string, expression: string): Promise<T> => {
    const result = await cdp.send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      session,
    )
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  return {
    root,
    dataDir,
    profile,
    evidence,
    cdp,
    install: { stdout: install.stdout, status: install.status },
    inWorker: (expression) => evaluate(worker, expression),
    async openTab(url) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url })
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('Runtime.enable', {}, sessionId)
      return sessionId
    },
    evaluate,
    async screenshot(session, name) {
      const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, session)
      const path = join(evidence, name)
      writeFileSync(path, Buffer.from(data, 'base64'))
      return path
    },
    async dispose() {
      await cdp.send('Browser.close').catch(() => {})
      cdp.close()
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'Chrome to exit', 10_000).catch(() => {})
      spawnSync('pkill', ['-f', profile])
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const check = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message)
}

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
  for (const dir of ['native-host', 'extension']) lines.push(`~/.ezdesign/${dir}: ${existsSync(join(homedir(), '.ezdesign', dir))}`)
  return lines.sort().join('\n')
}

export const checks: Check[] = [
  {
    name: 'CX-host-install: a Chrome started without PATH reaches the installed host',
    async run(h) {
      check(h.install.status === 0, 'install failed')
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
      writeFileSync(join(h.evidence, 'host-manifest.json'), JSON.stringify(manifest, null, 2))
      writeFileSync(join(h.evidence, 'wrapper.sh'), script)

      const state = await h.inWorker<HostState>('__ezCapture.host({ recheck: true })')
      writeFileSync(join(h.evidence, 'host-state.json'), JSON.stringify(state, null, 2))
      check(state.type === 'ready', `host state ${JSON.stringify(state)}`)
      if (state.type !== 'ready') return
      check(state.version === PKG_VERSION, `host version ${state.version}`)
      check(state.libraryDir === join(h.dataDir, 'library'), `library ${state.libraryDir}`)

      const generation = readdirSync(join(h.dataDir, 'extension', 'g'))[0]
      const page = await h.openTab(`chrome-extension://${EXTENSION_ID}/g/${generation}/setup.html`)
      await waitFor(
        () => h.evaluate<boolean>(page, `document.querySelector('.state')?.textContent === '已連線'`),
        'the setup page to show 已連線',
      )
      const shown = await h.evaluate<string[]>(page, `[...document.querySelectorAll('dd')].map((d) => d.textContent)`)
      check(shown[0] === PKG_VERSION && shown[2] === join(h.dataDir, 'library'), `setup page shows ${JSON.stringify(shown)}`)
      await h.screenshot(page, 'setup-connected.png')
    },
  },
]

async function main(): Promise<number> {
  const at = process.argv.indexOf('--evidence')
  const evidence = at >= 0 ? process.argv[at + 1]! : mkdtempSync(join(tmpdir(), 'ezdesign-capture-evidence-'))
  const chrome = findChromeForTesting()
  if (!chrome) {
    console.log('SKIP capture e2e: no Chrome for Testing (install it with `npx playwright install chromium`, or set EZDESIGN_CFT)')
    return 0
  }
  if (!existsSync(join(REPO, 'dist/cli.mjs'))) {
    console.log('FAIL capture e2e: no build; run `npm run build` first')
    return 1
  }
  const footprint = realHomeFootprint()
  const h = await launch(chrome, evidence)
  let failed = 0
  try {
    for (const c of checks) {
      try {
        await c.run(h)
        console.log(`PASS ${c.name}`)
      } catch (error) {
        failed++
        console.log(`FAIL ${c.name}\n  ${(error as Error).message.split('\n').join('\n  ')}`)
      }
    }
  } finally {
    await h.dispose()
  }
  const touched = realHomeFootprint() !== footprint
  console.log(`${touched ? 'FAIL' : 'PASS'} the real home is untouched (~/Library/Application Support, ~/.ezdesign)`)
  console.log(`evidence ${evidence}`)
  return failed || touched ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code))
}
