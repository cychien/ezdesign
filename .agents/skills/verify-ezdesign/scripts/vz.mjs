#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..')
const REPO = resolve(SKILL_DIR, '../../..')
const FIXTURE = realpathSync(join(REPO, 'fixtures/playground'))
const CLI = join(REPO, 'dist/cli.mjs')
const PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const REPO_HASH = createHash('sha1').update(REPO).digest('hex').slice(0, 8)
const RUN_DIR = process.env.EZDESIGN_VERIFY_RUN_DIR ?? join(tmpdir(), `ezdesign-verify-${REPO_HASH}`)
const STATE_FILE = join(RUN_DIR, 'state.json')
const DATA_DIR = join(RUN_DIR, 'data')
const LOG_DIR = join(RUN_DIR, 'logs')
const BROWSER_OPENER_STUB_DIR = join(RUN_DIR, 'bin')
const OPENED_LOG = join(RUN_DIR, 'opened.log')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (msg) => console.log(msg)
const die = (msg, code = 1) => {
  console.error(`vz: ${msg}`)
  process.exit(code)
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  mkdirSync(RUN_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function commandOf(pid) {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

function portAnswers(port) {
  return Promise.all(['127.0.0.1', '::1'].map((host) => connects(host, port))).then((r) =>
    r.some(Boolean),
  )
}

function connects(host, port) {
  return new Promise((done) => {
    const socket = connect({ host, port })
    const finish = (ok) => {
      socket.destroy()
      done(ok)
    }
    socket.setTimeout(400, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function freeRange(start, step, width, limit) {
  for (let base = start; base < start + limit; base += step) {
    const ports = Array.from({ length: width }, (_, i) => base + i)
    const busy = await Promise.all(ports.map(portAnswers))
    if (!busy.some(Boolean)) return base
  }
  throw new Error(`no free port range from ${start}`)
}

function runEnv(state) {
  return {
    ...process.env,
    EZDESIGN_DATA_DIR: state.dataDir,
    EZDESIGN_CONTROL_PORT: String(state.controlPort),
    EZDESIGN_NO_UPDATE_CHECK: '1',
    PATH: `${BROWSER_OPENER_STUB_DIR}:${process.env.PATH}`,
  }
}

function stubBrowserOpeners() {
  mkdirSync(BROWSER_OPENER_STUB_DIR, { recursive: true })
  for (const name of ['open', 'xdg-open']) {
    const file = join(BROWSER_OPENER_STUB_DIR, name)
    writeFileSync(file, `#!/bin/sh\necho "$(date +%s) ${name} $*" >> "${OPENED_LOG}"\n`)
    chmodSync(file, 0o755)
  }
}

async function getJson(url, timeout = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'x-ezdesign-version': PKG.version } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function getText(url, accept = '*/*', timeout = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept } })
    return { status: res.status, body: await res.text() }
  } catch (err) {
    return { status: 0, body: String(err) }
  }
}

function registry(state) {
  try {
    return JSON.parse(readFileSync(join(state.dataDir, 'daemon.json'), 'utf8'))
  } catch {
    return null
  }
}

function newestMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs)
  }
  return newest
}

function gitHead() {
  const r = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

function evidenceDir() {
  if (process.env.VZ_EVIDENCE_DIR) return process.env.VZ_EVIDENCE_DIR
  const candidates = [
    join(homedir(), '.claude/skills/verify/scripts/verify.py'),
    join(homedir(), '.agents/skills/verify/scripts/verify.py'),
  ]
  const script = candidates.find(existsSync)
  if (script) {
    const r = spawnSync('python3', [script, 'where'], { cwd: REPO, encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return join(tmpdir(), `ezdesign-verify-evidence-${REPO_HASH}`)
}

function sessionKey(project) {
  return createHash('sha1').update(project).digest('hex').slice(0, 12)
}

const hexId = (seed) => createHash('sha1').update(seed).digest('hex').slice(0, 12)

function writeSession(dataDir, files) {
  const dir = join(dataDir, 'sessions', sessionKey(files.session.project))
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2))
  }
}

/** An active session is attached to its dev server and comes back when the
 *  daemon starts, as one a long-lived daemon was serving does. */
function sessionLife(origin, state, epoch) {
  return state === 'ended'
    ? { app: { kind: 'none' }, state, endedBy: 'user' }
    : { app: { kind: 'attached', origin, attachedAt: epoch }, restoreOnStart: true, state }
}

/** The fixture's canvases, as the daemon's workspace writes them. Every dataset
 *  starts from none, so a seed never inherits another's. */
const FIXTURE_STATE = join(FIXTURE, '.ezdesign')
const FIXTURE_CANVASES = join(FIXTURE_STATE, 'canvases')
/** `npm run dev` keeps its canvases in the same folder, so a seed marks the
 *  folder as its own and vz never deletes one it did not mark. */
const SEEDED_MARK = join(FIXTURE_STATE, '.vz-seeded')
const DEV_REGISTRY = join(REPO, '.dev', 'daemon.json')

/** Why the fixture's `.ezdesign` is not this stack's to replace, or null. */
function fixtureStateTaken() {
  let dev = null
  try {
    dev = JSON.parse(readFileSync(DEV_REGISTRY, 'utf8'))
  } catch {}
  if (dev && alive(dev.pid) && commandOf(dev.pid).includes('__daemon')) {
    return `\`npm run dev\` is running in this checkout (daemon ${dev.pid}) and keeps its canvases in fixtures/playground/.ezdesign`
  }
  if (existsSync(FIXTURE_STATE) && !existsSync(SEEDED_MARK)) {
    return 'fixtures/playground/.ezdesign holds canvases no seed wrote, most likely from `npm run dev`'
  }
  return null
}

function requireFixtureState() {
  const taken = fixtureStateTaken()
  if (taken) die(`${taken}. vz never touches them: stop it, or run the verify stack from a git worktree, which has its own fixture.`)
}

function removeSeededState() {
  if (existsSync(SEEDED_MARK)) rmSync(FIXTURE_STATE, { recursive: true, force: true })
}

function writeCanvases(canvases, epoch) {
  requireFixtureState()
  removeSeededState()
  mkdirSync(FIXTURE_STATE, { recursive: true })
  writeFileSync(SEEDED_MARK, '')
  canvases.forEach((c, ci) => {
    const id = hexId(`canvas|${ci}|${c.name}`)
    const dir = join(FIXTURE_CANVASES, id)
    mkdirSync(join(dir, 'frames'), { recursive: true })
    const frames = c.grid
      ? Array.from({ length: c.grid.count }, (_, i) => ({
          title: `方向 ${i + 1}`,
          file: c.grid.file,
          n: i + 1,
          x: (i % c.grid.columns) * (c.grid.width + c.grid.gap),
          y: Math.floor(i / c.grid.columns) * (c.grid.height + c.grid.gap),
          width: c.grid.width,
          height: c.grid.height,
        }))
      : c.frames
    const manifest = { schema: 1, id, name: c.name, createdAt: epoch + ci * 1000, frames: [] }
    const rects = {}
    frames.forEach((f, fi) => {
      const frameId = hexId(`frame|${ci}|${fi}`)
      const html = readFileSync(join(SKILL_DIR, 'datasets', f.file), 'utf8').replaceAll('$N', String(f.n ?? fi + 1))
      writeFileSync(join(dir, 'frames', `${frameId}.html`), html)
      const hash = createHash('sha1').update(html).digest('hex').slice(0, 12)
      manifest.frames.push({ id: frameId, title: f.title, file: `frames/${frameId}.html`, hash, createdAt: epoch })
      rects[frameId] = { x: f.x, y: f.y, width: f.width, height: f.height }
    })
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ schema: 1, rects }, null, 2))
    writeFileSync(join(dir, 'canvas.json'), JSON.stringify(manifest, null, 2))
  })
}

function loadDataset(name, state) {
  const file = join(SKILL_DIR, 'datasets', `${name}.json`)
  if (!existsSync(file)) die(`no dataset ${name} (have: ${datasets().join(', ')})`)
  const spec = JSON.parse(readFileSync(file, 'utf8'))
  rmSync(state.dataDir, { recursive: true, force: true })
  mkdirSync(state.dataDir, { recursive: true })
  const epoch = Date.parse(spec.epoch ?? '2026-01-01T00:00:00Z')
  writeCanvases(spec.canvases ?? [], epoch)
  let clock = epoch
  const tick = (ms = 45_000) => (clock += ms)

  for (const s of spec.sessions ?? []) {
    const origin = s.origin.replace('$FIXTURE_ORIGIN', state.fixtureOrigin)
    const project = s.project.replace('$FIXTURE_ROOT', FIXTURE)
    const chats = []
    const conversation = []
    const outbox = []
    const chatPlan = s.chats ?? [{ batches: 0 }]
    chatPlan.forEach((plan, c) => {
      const chatId = hexId(`${origin}|chat|${c}`)
      chats.push({ id: chatId, startedAt: tick(), ...(s.agent ? { agent: s.agent } : {}) })
      for (let b = 0; b < plan.batches; b++) {
        const batchId = hexId(`${origin}|batch|${c}|${b}`)
        const picks = Array.from({ length: plan.itemsPerBatch ?? 1 }, (_, i) =>
          s.anchors[(b * 3 + i + c) % s.anchors.length],
        )
        const comment = (i) => s.comments[(b + i + c) % s.comments.length]
        const items = picks.map((a, i) => ({
          id: hexId(`${batchId}|item|${i}`),
          kind: a.kind ?? 'element',
          comment: comment(i),
          anchor: a.anchor,
          createdAt: tick(5_000),
        }))
        const sentAt = tick()
        outbox.push({ batchId, items, note: null, sentAt, deliveredAt: sentAt + 500, ackedAt: sentAt + 900 })
        conversation.push({
          role: 'user',
          text: '',
          ts: sentAt,
          batchId,
          chatId,
          items: items.map((it, i) => ({ comment: it.comment, where: picks[i].where })),
        })
        conversation.push({
          role: 'agent',
          text: s.replies[(b + c) % s.replies.length].replace('$N', String(b + 1)),
          ts: tick(),
          batchId,
          chatId,
        })
      }
    })
    const queue = Array.from({ length: s.queued ?? 0 }, (_, i) => {
      const a = s.anchors[i % s.anchors.length]
      return {
        id: hexId(`${origin}|queue|${i}`),
        kind: a.kind ?? 'element',
        comment: `${s.comments[i % s.comments.length]} (queued #${i + 1})`,
        anchor: a.anchor,
        createdAt: tick(5_000),
      }
    })
    const session = {
      project,
      ...sessionLife(origin, s.state ?? 'active', epoch),
      createdAt: epoch,
      chats,
      currentChatId: chats[chats.length - 1].id,
    }
    writeSession(state.dataDir, { session, queue, outbox, conversation })
  }

  for (const g of spec.generated ?? []) {
    for (let i = 0; i < g.count; i++) {
      const origin = `http://localhost:${g.firstPort + i}`
      const project = join(g.projectBase, `project-${String(i).padStart(3, '0')}`)
      const chatId = hexId(`${origin}|chat|0`)
      const conversation = Array.from({ length: g.entries }, (_, e) => ({
        role: e % 2 ? 'agent' : 'user',
        text: e % 2 ? 'done' : g.note,
        ts: tick(1_000),
        chatId,
        ...(e % 2 ? {} : { items: [] }),
      }))
      writeSession(state.dataDir, {
        session: {
          project,
          ...sessionLife(origin, g.state, epoch),
          createdAt: epoch,
          chats: [{ id: chatId, startedAt: epoch }],
          currentChatId: chatId,
        },
        queue: [],
        outbox: [],
        conversation,
      })
    }
  }
  return spec
}

function datasets() {
  return readdirSync(join(SKILL_DIR, 'datasets'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
}

function runCli(state, args, { capture = false } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: FIXTURE,
    env: runEnv(state),
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 120_000,
  })
  return r
}

function openSession(state) {
  const r = runCli(state, [`${state.fixtureOrigin}/`], { capture: true })
  if (r.status !== 0) die(`ezdesign open failed (${r.status}):\n${r.stdout}${r.stderr}`)
  const shell = /shell:\s+(\S+)/.exec(r.stdout)?.[1]
  if (!shell) die(`ezdesign open printed no shell url:\n${r.stdout}`)
  const reg = registry(state)
  if (!reg) die('daemon registry missing after open')
  state.shellUrl = shell
  state.sessionPort = Number(new URL(shell).port)
  state.daemonPid = reg.pid
  state.daemonPids = [...new Set([...(state.daemonPids ?? []), reg.pid])]
  state.openOutput = r.stdout.trim()
  writeState(state)
  return r.stdout
}

async function stopDaemon(state) {
  const reg = registry(state)
  const pids = new Set([...(state.daemonPids ?? []), ...(reg ? [reg.pid] : [])])
  if (reg) {
    await fetch(`http://127.0.0.1:${reg.port}/control/stop`, { method: 'POST', signal: AbortSignal.timeout(1500) }).catch(() => {})
  }
  for (const pid of pids) await reap(pid, (cmd) => cmd.includes(CLI) && cmd.includes('__daemon'))
  killRecordedAgentGroups(state)
}

function killRecordedAgentGroups(state) {
  try {
    const rec = JSON.parse(readFileSync(join(state.dataDir, 'agent-children.json'), 'utf8'))
    for (const child of rec.children ?? []) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
    }
  } catch {}
}

async function reap(pid, isOurs, { group = false } = {}) {
  const target = group ? -pid : pid
  for (let i = 0; i < 30 && alive(pid); i++) await delay(100)
  if (!alive(pid)) return
  if (!isOurs(commandOf(pid))) return say(`  pid ${pid} is no longer ours (${commandOf(pid)}) - left alone`)
  try {
    process.kill(target, 'SIGTERM')
  } catch {}
  for (let i = 0; i < 30 && alive(pid); i++) await delay(100)
  if (alive(pid) && isOurs(commandOf(pid))) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {}
  }
}

// ------------------------------------------------------------------ commands

async function cmdUp(args) {
  const existing = readState()
  if (existing && (alive(existing.vitePid) || alive(existing.daemonPid))) {
    die(`a stack from this checkout is already up (vite ${existing.vitePid}, daemon ${existing.daemonPid}) - run \`vz.mjs down\` first`)
  }
  const dataset = args.includes('--dataset') ? args[args.indexOf('--dataset') + 1] : 'baseline'
  requireFixtureState()
  rmSync(RUN_DIR, { recursive: true, force: true })
  mkdirSync(LOG_DIR, { recursive: true })

  if (!existsSync(join(REPO, 'node_modules/vite'))) {
    say('installing deps (pnpm install --frozen-lockfile)')
    const r = spawnSync('pnpm', ['install', '--frozen-lockfile', '--config.strict-dep-builds=false'], { cwd: REPO, stdio: 'inherit' })
    if (r.status !== 0) die('pnpm install failed')
  }
  if (!args.includes('--no-build')) {
    say('building (npm run build)')
    const log = openSync(join(LOG_DIR, 'build.log'), 'w')
    const r = spawnSync('npm', ['run', 'build'], { cwd: REPO, stdio: ['ignore', log, log] })
    closeSync(log)
    if (r.status !== 0) die(`build failed - see ${join(LOG_DIR, 'build.log')}`)
  }

  const h = parseInt(REPO_HASH, 16)
  const controlPort = await freeRange(4600 + (h % 30) * 10, 10, 10, 400)
  const fixturePort = await freeRange(5400 + (h % 100), 1, 1, 400)
  const state = {
    repo: REPO,
    head: gitHead(),
    version: PKG.version,
    runDir: RUN_DIR,
    dataDir: DATA_DIR,
    controlPort,
    fixturePort,
    fixtureOrigin: `http://localhost:${fixturePort}`,
    dataset,
    startedAt: new Date().toISOString(),
  }
  stubBrowserOpeners()
  writeState(state)

  const viteLog = openSync(join(LOG_DIR, 'vite.log'), 'w')
  const vite = spawn(
    process.execPath,
    [join(REPO, 'node_modules/vite/bin/vite.js'), '--config', 'vite.config.ts', '--port', String(fixturePort), '--strictPort'],
    { cwd: FIXTURE, env: { ...process.env, BROWSER: 'none' }, detached: true, stdio: ['ignore', viteLog, viteLog] },
  )
  vite.unref()
  closeSync(viteLog)
  state.vitePid = vite.pid
  writeState(state)

  const deadline = Date.now() + 30_000
  for (;;) {
    const app = await getText(`${state.fixtureOrigin}/src/sections/Hero.tsx`)
    if (app.status === 200 && app.body.includes('data-ez-source')) break
    if (!alive(vite.pid) || Date.now() > deadline) die(`fixture did not come up - see ${join(LOG_DIR, 'vite.log')}`)
    await delay(200)
  }
  say(`fixture  ${state.fixtureOrigin}/ (vite pid ${vite.pid})`)

  loadDataset(dataset, state)
  say(`dataset  ${dataset} loaded into ${state.dataDir}`)
  openSession(state)
  await waitReady(state)
  say(`daemon   pid ${state.daemonPid}, control range ${controlPort}-${controlPort + 9}`)
  say(`shell    ${state.shellUrl}`)
  say(`ready    run \`vz.mjs doctor\` next`)
}

async function waitReady(state) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const shell = await getText(state.shellUrl, 'text/html')
    const page = await getText(`http://127.0.0.1:${state.sessionPort}/`, 'text/html')
    if (shell.status === 200 && page.status === 200 && page.body.includes('/__ezdesign/overlay.js')) return
    await delay(200)
  }
  die('shell or proxied page did not answer within 15s - run `vz.mjs doctor`')
}

async function cmdSeed(args) {
  const name = args[0]
  if (!name) die(`usage: vz.mjs seed <${datasets().join('|')}>`)
  const state = readState()
  if (!state || !alive(state.vitePid)) die('no stack up - run `vz.mjs up` first')
  requireFixtureState()
  saveDaemonLog(state)
  await stopDaemon(state)
  loadDataset(name, state)
  state.dataset = name
  openSession(state)
  await waitReady(state)
  say(`dataset  ${name} loaded; daemon restarted (pid ${state.daemonPid}) and restored it`)
  say(`shell    ${state.shellUrl}`)
}

function saveDaemonLog(state) {
  const log = join(state.dataDir, 'daemon.log')
  if (existsSync(log)) cpSync(log, join(LOG_DIR, `daemon-${Date.now()}.log`))
}

async function cmdDoctor() {
  const state = readState()
  if (!state) die('no stack recorded for this checkout - run `vz.mjs up`')
  let failed = 0
  const check = (ok, label, detail = '') => {
    if (!ok) failed++
    say(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
  }
  check(state.repo === REPO, 'stack belongs to this checkout', state.repo)
  check(gitHead() === state.head, 'HEAD unchanged since up', `${state.head} -> ${gitHead()}`)
  const distFresh = existsSync(CLI) && statSync(CLI).mtimeMs >= newestMtime(join(REPO, 'src'))
  check(distFresh, 'dist/ is newer than src/ (the right build)', distFresh ? '' : 'rebuild: vz.mjs down && vz.mjs up')
  check(alive(state.vitePid) && commandOf(state.vitePid).includes('vite'), 'fixture vite process alive', `pid ${state.vitePid}`)
  const hero = await getText(`${state.fixtureOrigin}/src/sections/Hero.tsx`)
  check(hero.status === 200 && hero.body.includes('data-ez-source'), 'fixture serves source-stamped JSX', state.fixtureOrigin)
  const reg = registry(state)
  check(!!reg && reg.pid === state.daemonPid, 'daemon registry in the run data dir names our pid', reg ? `pid ${reg.pid}` : 'no daemon.json')
  const health = reg ? await getJson(`http://127.0.0.1:${reg.port}/control/health`) : null
  check(health?.ok && health.pid === state.daemonPid, 'control port owned by our daemon', reg ? `127.0.0.1:${reg.port}` : '')
  check(
    !!reg && reg.port >= state.controlPort && reg.port <= state.controlPort + 9,
    'control port inside the run range (not the user daemon range 4400-4409)',
    reg ? `${reg.port}` : '',
  )
  check(health?.version === PKG.version, 'daemon version matches package.json', `${health?.version} vs ${PKG.version}`)
  const sessions = reg ? await getJson(`http://127.0.0.1:${reg.port}/control/sessions`) : null
  const mine = sessions?.find((s) => s.project === FIXTURE)
  check(mine?.state === 'active' && mine.app === state.fixtureOrigin, 'fixture session active and attached to the fixture', mine ? `${mine.port} ${mine.app}` : 'none')
  check(mine?.port === state.sessionPort, 'session port matches the recorded shell url', `${mine?.port} vs ${state.sessionPort}`)
  const shell = await getText(state.shellUrl, 'text/html')
  check(shell.status === 200 && shell.body.includes('shell.js'), 'shell url serves the shell', state.shellUrl)
  const page = await getText(`http://127.0.0.1:${state.sessionPort}/`, 'text/html')
  check(page.body.includes('/__ezdesign/overlay.js'), 'proxied page has the overlay injected')
  say(`dataset ${state.dataset}; data dir ${state.dataDir}`)
  process.exit(failed ? 1 : 0)
}

function cmdCli(args) {
  const state = readState()
  if (!state) die('no stack recorded - run `vz.mjs up`')
  const rest = args[0] === '--' ? args.slice(1) : args
  const r = spawnSync(process.execPath, [CLI, ...rest], { cwd: FIXTURE, env: runEnv(state), stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

function cmdEnv() {
  const state = readState()
  if (!state) die('no stack recorded - run `vz.mjs up`')
  say(`export EZDESIGN_DATA_DIR='${state.dataDir}'`)
  say(`export EZDESIGN_CONTROL_PORT='${state.controlPort}'`)
  say(`export EZDESIGN_NO_UPDATE_CHECK=1`)
  say(`export PATH='${BROWSER_OPENER_STUB_DIR}':"$PATH"`)
}

function cmdStatus() {
  const state = readState()
  if (!state) die('no stack recorded - run `vz.mjs up`')
  say(JSON.stringify(derived(state), null, 2))
}

function derived(state) {
  return {
    ...state,
    sessionDir: join(state.dataDir, 'sessions', sessionKey(FIXTURE)),
    axiSession: `vz-${REPO_HASH}`,
    evidenceDir: evidenceDir(),
    fixtureRoot: FIXTURE,
    opened: existsSync(OPENED_LOG) ? readFileSync(OPENED_LOG, 'utf8').trim().split('\n') : [],
  }
}

function cmdGet(args) {
  const state = readState()
  if (!state) die('no stack recorded - run `vz.mjs up`')
  const all = derived(state)
  if (!args[0] || !(args[0] in all)) die(`usage: vz.mjs get <${Object.keys(all).join('|')}>`)
  const value = all[args[0]]
  say(typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value, null, 2))
}

async function cmdDown() {
  const state = readState()
  if (!state) {
    say('nothing recorded for this checkout')
    rmSync(RUN_DIR, { recursive: true, force: true })
    return
  }
  const saved = join(evidenceDir(), 'vz-logs', new Date().toISOString().replace(/[:.]/g, '-'))
  saveDaemonLog(state)
  await stopDaemon(state)
  if (state.vitePid) await reap(state.vitePid, (cmd) => cmd.includes('vite'), { group: true })
  const leftovers = [state.vitePid, ...(state.daemonPids ?? [])].filter(alive)
  if (existsSync(LOG_DIR)) {
    mkdirSync(saved, { recursive: true })
    cpSync(LOG_DIR, saved, { recursive: true })
    if (existsSync(OPENED_LOG)) cpSync(OPENED_LOG, join(saved, 'opened.log'))
  }
  rmSync(RUN_DIR, { recursive: true, force: true })
  removeSeededState()
  say(leftovers.length ? `WARNING: still alive: ${leftovers.join(', ')}` : 'stopped vite and daemon; run dir removed')
  say(`logs kept in ${saved}`)
  if (leftovers.length) process.exit(1)
}

async function cmdConsumer() {
  const out = join(evidenceDir(), 'consumer')
  mkdirSync(out, { recursive: true })
  const work = join(RUN_DIR, 'consumer')
  rmSync(work, { recursive: true, force: true })
  const home = join(work, 'home')
  const app = join(work, 'app')
  mkdirSync(home, { recursive: true })
  mkdirSync(app, { recursive: true })
  const transcript = []
  const npmCache = spawnSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8' }).stdout.trim()
  const controlPort = await freeRange(4900, 10, 10, 400)
  const env = {
    ...process.env,
    HOME: home,
    npm_config_cache: npmCache,
    EZDESIGN_DATA_DIR: join(work, 'data'),
    EZDESIGN_CONTROL_PORT: String(controlPort),
    EZDESIGN_NO_UPDATE_CHECK: '1',
    PATH: `${BROWSER_OPENER_STUB_DIR}:${process.env.PATH}`,
  }
  let failed = 0
  const step = (label, cmd, argv, opts = {}) => {
    const r = spawnSync(cmd, argv, { cwd: opts.cwd ?? app, env: opts.env ?? env, encoding: 'utf8', timeout: 300_000 })
    const ok = opts.expect ? opts.expect(r) : r.status === 0
    if (!ok) failed++
    transcript.push(`$ ${[cmd, ...argv].join(' ')}   # ${label}`, r.stdout.trim(), r.stderr.trim(), `exit ${r.status} -> ${ok ? 'ok' : 'FAIL'}`, '')
    say(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
    return r
  }
  stubBrowserOpeners()
  step('build', 'npm', ['run', 'build'], { cwd: REPO, env: process.env })
  const pack = step('npm pack', 'npm', ['pack', '--json', '--pack-destination', work], { cwd: REPO, env: process.env })
  const info = JSON.parse(pack.stdout)[0]
  const files = info.files.map((f) => f.path)
  writeFileSync(join(out, 'tarball-files.txt'), files.join('\n') + '\n')
  const extension = JSON.parse(readFileSync(join(REPO, 'dist/extension/manifest.json'), 'utf8'))
  const extensionFiles = [extension.background.service_worker, ...(extension.web_accessible_resources ?? []).flatMap((w) => w.resources)]
  const required = ['dist/cli.mjs', 'dist/vite.mjs', 'dist/vite.d.ts', 'dist/shell.js', 'dist/shell.css', 'dist/overlay.js', 'dist/overlay.css', 'dist/events-worker.js', 'dist/native-host.mjs', 'dist/extension/manifest.json', ...extensionFiles.map((f) => `dist/extension/${f}`), 'skills/ezdesign/SKILL.md', 'README.md', 'LICENSE', 'package.json']
  const missing = required.filter((f) => !files.includes(f))
  const stray = files.filter((f) => /^(src|test|fixtures|scripts|\.agents|\.claude)\//.test(f))
  transcript.push(`# tarball ${info.filename} (${info.name}@${info.version}): ${files.length} files; missing: ${missing.join(', ') || 'none'}; stray: ${stray.join(', ') || 'none'}`, '')
  const misnamed = info.name !== PKG.name || info.filename !== `${PKG.name.replace('@', '').replace('/', '-')}-${PKG.version}.tgz`
  if (missing.length || stray.length || misnamed) failed++
  say(`${missing.length || stray.length || misnamed ? 'FAIL' : 'ok  '} tarball ${info.filename} contents (${files.length} files)`)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer-app', private: true, type: 'module' }, null, 2))
  step('install tarball into a fresh project', 'npm', ['install', '--no-audit', '--no-fund', join(work, info.filename)], {
    expect: (r) => r.status === 0 && existsSync(join(app, 'node_modules', PKG.name, 'dist', 'cli.mjs')),
  })
  const bin = join(app, 'node_modules/.bin/ezdesign')
  step('bin --version', bin, ['--version'], { expect: (r) => r.status === 0 && r.stdout.trim() === PKG.version })
  step('bin --help', bin, ['--help'], { expect: (r) => r.status === 0 && r.stdout.startsWith('ezdesign - ') && r.stdout.includes('Usage:') })
  step('bin status (no daemon)', bin, ['status'], { expect: (r) => r.status === 0 && r.stdout.includes('daemon: not running') })
  step('bad EZDESIGN_CONTROL_PORT is fatal', bin, ['status'], {
    env: { ...env, EZDESIGN_CONTROL_PORT: 'abc' },
    expect: (r) => r.status === 1 && r.stderr.includes('EZDESIGN_CONTROL_PORT must be an integer'),
  })
  step('import @cychien/ezdesign/vite', 'node', ['--input-type=module', '-e', "import { ezdesignSource } from '@cychien/ezdesign/vite'; const p = ezdesignSource(); if (p.name !== 'ezdesign:source' || p.apply !== 'serve' || typeof p.transform !== 'function') process.exit(1); const out = p.transform('export const A = () => <div>hi</div>', process.cwd() + '/A.tsx'); console.log(out && out.code); if (!out || !out.code.includes('data-ez-source=\"A.tsx:1\"')) process.exit(1)"])
  step('bin extension status (nothing installed)', bin, ['extension', 'status'], {
    expect: (r) => r.status === 1 && r.stdout.startsWith('host: not installed') && !existsSync(join(home, '.ezdesign')),
  })
  const state = readState()
  if (state && alive(state.vitePid)) {
    let installedDaemon = null
    try {
      const open = step('installed bin opens a session on the fixture', bin, [`${state.fixtureOrigin}/`], { cwd: FIXTURE })
      installedDaemon = registry({ dataDir: env.EZDESIGN_DATA_DIR })?.pid ?? null
      const shell = /shell:\s+(\S+)/.exec(open.stdout)?.[1]
      if (shell) {
        const page = await getText(shell, 'text/html')
        const js = await getText(new URL('/__ezdesign/shell.js', shell).href)
        const ok = page.status === 200 && js.status === 200 && js.body.length > 1000
        if (!ok) failed++
        transcript.push(`# GET ${shell} -> ${page.status}; shell.js -> ${js.status} (${js.body.length} bytes)`, '')
        say(`${ok ? 'ok  ' : 'FAIL'} installed daemon serves the shell and its assets`)
      }
    } finally {
      step('installed bin stop', bin, ['stop'], { expect: (r) => r.status === 0 && r.stdout.includes('daemon stopped') })
      if (installedDaemon) await reap(installedDaemon, (cmd) => cmd.includes(work))
    }
  } else {
    say('skip installed-bin session (no stack up; run `vz.mjs up` first to include it)')
  }
  const leakedHome = existsSync(join(home, '.ezdesign'))
  transcript.push(`# isolated HOME has .ezdesign: ${leakedHome}`)
  if (leakedHome) failed++
  writeFileSync(join(out, 'transcript.txt'), transcript.join('\n') + '\n')
  rmSync(work, { recursive: true, force: true })
  say(`transcript ${join(out, 'transcript.txt')}`)
  process.exit(failed ? 1 : 0)
}

const HELP = `vz.mjs - drive ezdesign the way a user does (one isolated stack per checkout)

  up [--dataset <name>] [--no-build]   install deps if missing, build, start the fixture and
                                       the daemon, load a dataset (default baseline), open the session
  seed <name>                          stop our daemon, rewrite the data dir with a dataset, restart
  doctor                               read-only health check; exit 1 when the stack is not worth driving
  cli -- <args...>                     run dist/cli.mjs against this stack (cwd = fixture)
  env                                  print exports to drive the CLI by hand in a terminal
  status                               print the recorded state (urls, ports, pids, evidence dir)
  get <field>                          print one field: shellUrl, fixtureOrigin, sessionDir, axiSession, evidenceDir, ...
  evidence                             print (and create) the evidence directory
  consumer                             npm pack, install into a temp project with isolated HOME, drive the bin
  down                                 stop what this run started, save logs to evidence, remove the run dir

run dir: ${RUN_DIR}
datasets: ${datasets().join(', ')}`

const [cmd, ...args] = process.argv.slice(2)
const commands = {
  up: () => cmdUp(args),
  seed: () => cmdSeed(args),
  doctor: cmdDoctor,
  cli: () => cmdCli(args),
  env: cmdEnv,
  status: cmdStatus,
  get: () => cmdGet(args),
  evidence: () => {
    const dir = evidenceDir()
    mkdirSync(dir, { recursive: true })
    say(dir)
  },
  consumer: cmdConsumer,
  down: cmdDown,
}
if (!cmd || cmd === 'help' || cmd === '--help') say(HELP)
else if (!commands[cmd]) die(`unknown command ${cmd}\n\n${HELP}`)
else await commands[cmd]()
