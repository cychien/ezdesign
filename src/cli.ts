import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import open, { apps } from 'open'
import {
  DEFAULT_CONTROL_PORT,
  APP_NAME,
  POLL_RETRIES,
  URL_PREFIX,
  assertControlPortEnv,
} from './constants.js'
import { agentCommand } from './agents.js'
import {
  type CaptureStatus,
  CaptureInstallError,
  type HostProblem,
  captureStatus,
  installCapture,
  uninstallCapture,
} from './capture-install/index.js'
import {
  clearInspireToken,
  credentialsFile,
  readInspireToken,
  writeInspireToken,
} from './credentials.js'
import { daemonMain } from './daemon.js'
import {
  DEFAULT_INSPIRE_URL,
  InspireError,
  cacheFiles,
  parseSearchArgs,
  renderSearch,
  search,
  withLocalPaths,
} from './inspire.js'
import { projectRoot } from './project-root.js'
import { ensureDaemon, findRunningDaemon } from './registry.js'
import { VERSION_HEADER } from './version.js'
import type { PollResult } from './protocol.js'

const cliEntry = fileURLToPath(import.meta.url)
const pkg = JSON.parse(readFileSync(join(dirname(cliEntry), '../package.json'), 'utf8')) as {
  version: string
}

const EXTENSION_HELP = `  ${APP_NAME} extension install [--user-data-dir <dir>] | uninstall | status
      install the native host the Chrome capture extension saves through, and
      print the folder to load in chrome://extensions. Saving needs no daemon
      and no session; items go to the design library in the data dir.
      --user-data-dir installs into that one browser profile only. uninstall
      removes the host and the extension folder, never the library
`

const HELP = `${APP_NAME} - annotate your live dev app, feedback flows to your local agent

Usage:
  ${APP_NAME} [<url>] [--reopen] [--agent <name|command>]
      open (or resume) this project's review session. With <url>, that dev
      server is on its App tab (a dev server that moved ports keeps the
      conversation); without one, the shell opens on the project's canvases.
      --agent (SPIKE) drives the agent over ACP: the session spawns it, feedback
      goes straight to it, and its stream, questions and permission prompts all
      surface in the review shell - no terminal needed. Profiles: claude, gemini,
      codex; anything else is run as an ACP agent command line.
  ${APP_NAME} poll [<url>] [--agent-reply <msg>]
      block until the user sends feedback; prints JSON, then exits
  ${APP_NAME} progress [<url>] <msg>
      update the "working on it" line in the review shell; send between edits
  ${APP_NAME} end [<url>]
      end the session as the agent
      (poll, progress and end find the session by the project you run them
      from, never by url; a <url> is only checked against the attached app)
  ${APP_NAME} status | stop
      show session status / stop the background daemon
  ${APP_NAME} login [--token <t>] | logout
      store (or forget) the inspiration database token, mode 600 in the data dir
  ${APP_NAME} inspire [--query "<text>"] [--tag a,b] [--limit n] [--json]
      search the inspiration database by a description of what the piece has to
      show, by tags, or both. Each result's images and code are cached locally
      and printed as paths
${EXTENSION_HELP}  ${APP_NAME} --version | --help

Environment:
  ${APP_NAME.toUpperCase()}_DATA_DIR       session state, daemon registry and log (default: ~/.${APP_NAME})
      A separate data dir alone runs an isolated second instance: a daemon only
      adopts a live one serving its own data dir, so instances can share a range.
  ${APP_NAME.toUpperCase()}_CONTROL_PORT   first port of the daemon's ten-port control range (default: ${DEFAULT_CONTROL_PORT})
  ${APP_NAME.toUpperCase()}_NO_UPDATE_CHECK=1  never ask the npm registry whether a newer version exists
  ${APP_NAME.toUpperCase()}_INSPIRE_URL    inspiration API base (default: ${DEFAULT_INSPIRE_URL})

A restarted daemon picks its sessions back up from disk and re-binds each to the
port it last held, so an open review shell only needs a reload and queued
feedback is still there.

A session is the project you run this from (nearest .git or package.json),
not the url, so two projects sharing a dev-server port never see each other's
review, and one dev server attaches to one project at a time.

Examples:
  ${APP_NAME} http://localhost:5173/
  ${APP_NAME} poll --agent-reply "改好了 hero 區塊，請再看一次"
`

function fail(message: string, hint?: string): never {
  console.error(`error: ${message}`)
  if (hint) console.error(`hint: ${hint}`)
  process.exit(1)
}

/** Which session an agent-side command acts for. The project is read from the
 *  cwd by the one rule the daemon and the Vite plugin share and is the only
 *  handle; a url the caller still passes is checked against the session's
 *  attached origin and only ever warned about, never used to find a session. */
interface SessionHandle {
  project: string
  url: URL | null
}

const VALUE_FLAGS = new Set(['--agent-reply'])

/** `[<url>]` off the front of a subcommand's words. Positional by count, not by
 *  shape: `progress` takes one more word than the others, so with
 *  `positionals = 1` a lone word is the message even when it looks like a host,
 *  and only a second word makes the first one a url. */
function parseSessionArgs(
  words: string[],
  positionals: number,
): { handle: SessionHandle; rest: string[] } {
  const plain: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word.startsWith('--')) {
      if (VALUE_FLAGS.has(word)) i++
      continue
    }
    plain.push(word)
  }
  const url = plain.length > positionals ? parseTarget(plain.shift()) : null
  return { handle: { project: projectRoot(process.cwd()), url }, rest: plain }
}

function parseTarget(raw: string | undefined): URL {
  if (!raw) fail('missing <url>', `e.g. ${APP_NAME} http://localhost:5173/`)
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    return url
  } catch {
    fail(`invalid url: ${raw}`)
  }
}

const versionedHeaders = { 'content-type': 'application/json', [VERSION_HEADER]: pkg.version }

async function controlFetch(
  daemonPort: number,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemonPort}${path}`, {
    headers: versionedHeaders,
    ...init,
  })
}

/** A 409 is the daemon refusing a version skew — retrying cannot fix it, so it
 *  is fatal even on paths that otherwise ride out failures. */
async function failOnVersionSkew(res: Response): Promise<void> {
  if (res.status !== 409) return
  const body = (await res.json()) as { error?: string; hint?: string }
  fail(body.error ?? 'version mismatch with the daemon', body.hint)
}

interface SessionListing {
  project: string
  app?: string
  port: number
  state: string
  canvases?: number
}

async function openSessionsHint(daemonPort: number): Promise<string> {
  const start = `run \`${APP_NAME} <url>\` in this project first to open a session`
  const res = await controlFetch(daemonPort, '/control/sessions').catch(() => null)
  if (!res?.ok) return start
  const open = ((await res.json()) as SessionListing[]).filter((s) => s.state === 'active')
  if (!open.length) return start
  const lines = open.map((s) => `  ${s.project}${s.app ? ` (${s.app})` : ''}`)
  return [`${start}; open sessions:`, ...lines].join('\n')
}

/** `quiet` keeps a mid-poll reconnect from exiting while retries remain, and
 *  from repeating the url note. */
async function findSessionPort(handle: SessionHandle, opts?: { quiet?: boolean }): Promise<number> {
  const daemon = await findRunningDaemon()
  if (!daemon) {
    if (opts?.quiet) return 0
    fail('daemon is not running', `run \`${APP_NAME} <url>\` in this project first to open a session`)
  }
  const res = await controlFetch(
    daemon.port,
    `/control/sessions/find?project=${encodeURIComponent(handle.project)}`,
  )
  await failOnVersionSkew(res)
  if (!res.ok) {
    if (opts?.quiet) return 0
    fail(`no session for ${handle.project}`, await openSessionsHint(daemon.port))
  }
  const found = (await res.json()) as { port: number; app?: string }
  if (handle.url && handle.url.origin !== found.app && !opts?.quiet) {
    console.error(
      `note: ${handle.url.origin} is not this project's app (attached: ${found.app ?? 'none'}); using the project session`,
    )
  }
  return found.port
}

const sessionApi = (port: number, path: string) =>
  `http://127.0.0.1:${port}${URL_PREFIX}/api${path}`

/** Always give the shell its own browser window: a fresh window starts with a
 *  single history entry, which is the only condition under which the shell is
 *  allowed to close itself when the user ends the review. Falls back to a plain
 *  open when the default browser takes no `--new-window` (e.g. Safari). */
async function openShell(shellUrl: string): Promise<void> {
  try {
    await open(shellUrl, {
      newInstance: true,
      app: { name: apps.browser, arguments: ['--new-window'] },
    })
  } catch {
    await open(shellUrl)
  }
}


/** `ezdesign [<url>]`. With a url the dev server is probed first; without one
 *  nothing is probed and the shell opens on the project's canvases. Both go
 *  through the same control call. */
async function cmdOpen(
  rawUrl: string | undefined,
  flags: Set<string>,
  agentArg: string | undefined,
): Promise<void> {
  const target = rawUrl === undefined ? null : parseTarget(rawUrl)
  if (target) {
    try {
      await fetch(target.origin, { signal: AbortSignal.timeout(3000) })
    } catch {
      fail(
        `nothing is listening at ${target.origin}`,
        'start your dev server first, then re-run this command',
      )
    }
  }
  const daemon = await ensureDaemon(cliEntry, pkg.version)
  const project = projectRoot(process.cwd())
  const res = await controlFetch(daemon.port, '/control/sessions', {
    method: 'POST',
    body: JSON.stringify({
      ...(target ? { url: target.href } : {}),
      reopen: flags.has('--reopen'),
      project,
      ...(agentArg ? { agent: agentCommand(agentArg) } : {}),
    }),
  })
  const body = (await res.json()) as {
    shellUrl?: string
    error?: string
    hint?: string
    agent?: string
    app?: string
    shellOpen?: boolean
  }
  if (!res.ok) fail(body.error ?? `daemon returned ${res.status}`, body.hint)
  if (!body.shellOpen) await openShell(body.shellUrl!)
  console.log(`session: ${project}`)
  if (body.app) console.log(`app:     ${body.app}`)
  console.log(`shell:   ${body.shellUrl}${body.shellOpen ? ' (already open in your browser)' : ''}`)
  // The daemon's answer, not the flag: a restored session keeps its agent.
  if (body.agent) {
    console.log(`agent:   ${body.agent} (ACP) - review runs in the shell`)
  } else {
    console.log(`next:    run \`${APP_NAME} poll\` in this project and wait for feedback`)
  }
}

async function cmdPoll(handle: SessionHandle, reply: string | undefined): Promise<void> {
  let port = await findSessionPort(handle)
  if (reply?.trim()) {
    const res = await fetch(sessionApi(port, '/agent/reply'), {
      method: 'POST',
      headers: versionedHeaders,
      body: JSON.stringify({ message: reply.trim() }),
    })
    await failOnVersionSkew(res)
    if (!res.ok) fail(`failed to deliver --agent-reply (${res.status})`)
  }
  let attempt = 0
  for (;;) {
    let result: PollResult | { type: 'timeout' }
    try {
      const res = await fetch(sessionApi(port, '/agent/poll'), { headers: versionedHeaders })
      // Reached when a poll reconnects straight to a session port that a
      // restarted, different-version daemon re-bound — `find` never ran.
      await failOnVersionSkew(res)
      result = (await res.json()) as PollResult | { type: 'timeout' }
      attempt = 0
    } catch {
      if (++attempt > POLL_RETRIES) {
        fail(
          'lost connection to the daemon',
          `re-run \`${APP_NAME} poll\` - queued feedback is never lost`,
        )
      }
      await new Promise((r) => setTimeout(r, Math.min(4000, 400 * 2 ** (attempt - 1))))
      // A restarted daemon only prefers the port this session last held, so the
      // port may have moved - re-resolve instead of retrying a dead URL.
      port = await findSessionPort(handle, { quiet: attempt <= POLL_RETRIES })
      continue
    }
    if (result.type === 'timeout') continue
    if (result.type === 'feedback') {
      await fetch(sessionApi(port, '/agent/ack'), {
        method: 'POST',
        headers: versionedHeaders,
        body: JSON.stringify({ batchId: result.batchId }),
      }).catch(() => {})
    }
    console.log(JSON.stringify(result, null, 2))
    return
  }
}

async function cmdProgress(handle: SessionHandle, message: string | undefined): Promise<void> {
  if (!message?.trim()) fail('missing <message>', `e.g. ${APP_NAME} progress "adjusting the hero spacing"`)
  const port = await findSessionPort(handle)
  const res = await fetch(sessionApi(port, '/agent/progress'), {
    method: 'POST',
    headers: versionedHeaders,
    body: JSON.stringify({ message: message.trim() }),
  })
  await failOnVersionSkew(res)
  if (!res.ok) fail(`failed to deliver progress (${res.status})`)
}

async function cmdEnd(handle: SessionHandle): Promise<void> {
  const port = await findSessionPort(handle)
  await fetch(sessionApi(port, '/end'), {
    method: 'POST',
    headers: versionedHeaders,
    body: JSON.stringify({ by: 'agent' }),
  })
  console.log(`session for ${handle.project} ended`)
}

async function cmdStatus(): Promise<void> {
  const daemon = await findRunningDaemon()
  if (!daemon) {
    console.log('daemon: not running')
    return
  }
  console.log(`daemon: running (v${daemon.version}, pid ${daemon.pid}, control port ${daemon.port})`)
  const res = await controlFetch(daemon.port, '/control/sessions')
  await failOnVersionSkew(res)
  const sessions = (await res.json()) as SessionListing[]
  if (sessions.length === 0) console.log('sessions: none')
  for (const s of sessions) {
    console.log(`session: ${s.project} → 127.0.0.1:${s.port} (${s.state})`)
    if (s.app) console.log(`         app: ${s.app}`)
    if (s.canvases !== undefined) console.log(`         canvases: ${s.canvases} open`)
  }
}

async function cmdStop(): Promise<void> {
  const daemon = await findRunningDaemon()
  if (!daemon) {
    console.log('daemon: not running')
    return
  }
  await controlFetch(daemon.port, '/control/stop', { method: 'POST' })
  console.log('daemon stopped')
}

/** Exit 2: the step could not run. One line, since the agent reports a failed step in one. */
function failStep(message: string): never {
  console.error(`error: ${message}`)
  process.exit(2)
}

async function cmdLogin(args: string[]): Promise<void> {
  const at = args.indexOf('--token')
  if (at >= 0 && !args[at + 1]) fail('missing value for --token')
  let token = args[at + 1]?.trim()
  if (!token) {
    if (!process.stdin.isTTY) {
      fail('no token given', `run \`${APP_NAME} login --token <token>\` when there is no terminal`)
    }
    const { createInterface } = await import('node:readline/promises')
    const { Writable } = await import('node:stream')
    let echo = true
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (echo) process.stdout.write(chunk)
        done()
      },
    })
    const rl = createInterface({ input: process.stdin, output, terminal: true })
    // Raw mode reads Ctrl+C as a key; end the way the terminal would have.
    rl.on('SIGINT', () => {
      rl.close()
      process.stdout.write('\n')
      process.kill(process.pid, 'SIGINT')
    })
    try {
      const answer = rl.question('inspiration token: ')
      echo = false
      // Rejects only when Ctrl+D closes the prompt: no token.
      token = (await answer.catch(() => '')).trim()
    } finally {
      rl.close()
      process.stdout.write('\n')
    }
  }
  if (!token) fail('no token given')
  writeInspireToken(token)
  console.log(`token saved to ${credentialsFile()}`)
}

function cmdLogout(): void {
  console.log(clearInspireToken() ? 'inspiration token removed' : 'no inspiration token to remove')
}

async function cmdInspire(args: string[]): Promise<void> {
  const query = parseSearchArgs(args)
  if ('error' in query) {
    fail(query.error, `e.g. ${APP_NAME} inspire --query "a command menu over the whole product"`)
  }
  const token = readInspireToken()
  if (!token) failStep(`no inspiration token; run \`${APP_NAME} login\` first`)
  try {
    const response = await search(query, token)
    const files = await cacheFiles(response.results)
    console.log(
      query.json
        ? JSON.stringify(withLocalPaths(response, files), null, 2)
        : renderSearch(response, files, query),
    )
  } catch (err) {
    if (err instanceof InspireError) failStep(err.message)
    throw err
  }
}

function describeProblem(problem: HostProblem): string {
  switch (problem.type) {
    case 'not-installed':
      return `the capture host is not installed; run \`${APP_NAME} extension install\``
    case 'record-unreadable':
      return problem.message
    case 'node-missing':
      return `the host's node ${problem.node} is gone; run \`${APP_NAME} extension install\` again`
    case 'node-too-old':
      return `the host's node ${problem.node} is ${problem.version}, below 22.13; run \`${APP_NAME} extension install\` with a newer node`
    case 'stale':
      return `the host is ${problem.installed}, this ezdesign is ${problem.running}; it updates the next time the daemon starts`
    case 'files-missing':
      return `${problem.path} is missing; run \`${APP_NAME} extension install\` again`
    case 'manifest-missing':
      return `${problem.manifestPath} is missing; run \`${APP_NAME} extension install\` again`
    case 'manifest-foreign':
      return `${problem.manifestPath} points at ${problem.points ?? 'nothing readable'}, another install's host`
  }
}

function printStatus(status: CaptureStatus): void {
  const record = status.record
  console.log(record ? `host: ${record.version}, node ${record.node}` : 'host: not installed')
  for (const { target, installed } of status.targets) {
    console.log(`  ${installed ? 'installed' : 'not installed'}  ${target.browser?.name ?? target.userDataDir}`)
  }
  console.log(`extension folder: ${status.extensionDir}`)
  console.log(`library: ${status.libraryDir}`)
  for (const problem of status.problems) console.log(`problem: ${describeProblem(problem)}`)
}

async function cmdExtension(args: string[]): Promise<void> {
  const [verb, ...rest] = args
  const userDataDirs: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--user-data-dir') fail(`unknown option: ${rest[i]}`, `${APP_NAME} extension install [--user-data-dir <dir>]`)
    const dir = rest[++i]
    if (!dir) fail('missing value for --user-data-dir')
    userDataDirs.push(resolve(dir))
  }
  const placement = { distDir: dirname(cliEntry), version: pkg.version }
  try {
    switch (verb) {
      case 'install': {
        const report = await installCapture({ ...placement, userDataDirs: userDataDirs.length ? userDataDirs : undefined })
        console.log('installed the capture host for:')
        for (const target of report.targets) {
          console.log(`  ${target.browser ? `${target.browser.name}  ` : ''}${target.userDataDir}`)
        }
        console.log(`host node: ${report.node}`)
        console.log(`load the extension once: chrome://extensions > 開發人員模式 > 載入未封裝項目 > ${report.extensionDir}`)
        return
      }
      case 'uninstall': {
        if (userDataDirs.length) fail('uninstall takes no --user-data-dir; it removes every manifest it installed')
        const report = await uninstallCapture()
        for (const path of report.removedManifests) console.log(`removed ${path}`)
        for (const path of report.keptManifests) console.log(`kept ${path} (another install's host)`)
        console.log('removed the capture host and the extension folder; the library stays')
        return
      }
      case 'status': {
        const status = await captureStatus(placement)
        printStatus(status)
        if (status.problems.length) process.exitCode = 1
        return
      }
      default:
        fail(
          verb ? `unknown extension command: ${verb}` : 'missing extension command',
          `${APP_NAME} extension install | uninstall | status`,
        )
    }
  } catch (error) {
    if (error instanceof CaptureInstallError) fail(error.message, error.hint)
    throw error
  }
}

async function main(): Promise<void> {
  assertControlPortEnv()
  const argv = process.argv.slice(2)
  const [first, ...rest] = argv
  const flags = new Set(argv.filter((a) => a.startsWith('--')))

  if (first === '--help' || first === '-h' || first === 'help') {
    console.log(HELP)
    return
  }
  if (first === '--version' || first === '-v') {
    console.log(pkg.version)
    return
  }

  switch (first) {
    case '__daemon': {
      const succeedIdx = rest.indexOf('--succeed')
      const succeed = succeedIdx >= 0 ? Number(rest[succeedIdx + 1]) : undefined
      if (succeed !== undefined && !Number.isInteger(succeed)) fail('invalid --succeed pid')
      return daemonMain(pkg.version, { succeed })
    }
    case 'poll': {
      const replyIdx = rest.indexOf('--agent-reply')
      const reply = replyIdx >= 0 ? rest[replyIdx + 1] : undefined
      return cmdPoll(parseSessionArgs(rest, 0).handle, reply)
    }
    case 'progress': {
      const parsed = parseSessionArgs(rest, 1)
      return cmdProgress(parsed.handle, parsed.rest[0])
    }
    case 'end':
      return cmdEnd(parseSessionArgs(rest, 0).handle)
    case 'status':
      return cmdStatus()
    case 'stop':
      return cmdStop()
    case 'login':
      return cmdLogin(rest)
    case 'logout':
      return cmdLogout()
    case 'inspire':
      return cmdInspire(rest)
    case 'extension':
      return cmdExtension(rest)
    default: {
      const agentIdx = argv.indexOf('--agent')
      const agentArg = agentIdx >= 0 ? argv[agentIdx + 1] : undefined
      if (agentIdx >= 0 && !agentArg) fail('missing value for --agent', 'e.g. --agent claude')
      // A first argument that is a flag, or none, is an open with no url.
      return cmdOpen(first === undefined || first.startsWith('--') ? undefined : first, flags, agentArg)
    }
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
