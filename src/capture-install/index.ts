import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ALLOWED_ORIGINS, HOST_NAME } from '../capture-wire.js'
import { DATA_DIR, installedExtensionDir, libraryDir, nativeHostDir } from '../constants.js'
import { writeAtomic } from '../fs-atomic.js'
import { compareVersions } from '../update-check.js'
import { type HostTarget, hostTargets } from './browsers.js'
import { currentGeneration, installExtension } from './extension-files.js'

export type { HostTarget } from './browsers.js'

/** `node:sqlite` unflagged. */
export const HOST_NODE_FLOOR = '22.13.0'

const INSTALL_RECORD = 'install.json'
export const WRAPPER_NAME = 'ezdesign-native-host'
export const HOST_BUNDLE = 'host.mjs'

export class CaptureInstallError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'CaptureInstallError'
  }
}

export interface NodeCandidate {
  path: string
  version: string | null
}

export type NodeChoice = { ok: true; node: NodeCandidate } | { ok: false; reason: string }

export function chooseHostNode(current: NodeCandidate, recorded: NodeCandidate | null): NodeChoice {
  const fits = (n: NodeCandidate): boolean => n.version !== null && compareVersions(n.version, HOST_NODE_FLOOR) >= 0
  if (fits(current)) return { ok: true, node: current }
  if (recorded && fits(recorded)) return { ok: true, node: recorded }
  return {
    ok: false,
    reason: `the capture host needs Node >= ${HOST_NODE_FLOOR}; this is ${current.version ?? 'missing'} at ${current.path}`,
  }
}

/** Chrome starts it with no shell profile and often no PATH, so it names node absolutely. */
export function hostWrapperScript(options: { node: string; host: string; dataDir: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return [
    '#!/bin/sh',
    `EZDESIGN_DATA_DIR=${q(options.dataDir)} exec ${q(options.node)} ${q(options.host)} "$@"`,
    '',
  ].join('\n')
}

export function hostManifest(wrapper: string, allowedOrigins: readonly string[]): object {
  return {
    name: HOST_NAME,
    description: 'ezdesign capture: saves to the design library',
    path: wrapper,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  }
}

export interface InstallRecord {
  version: string
  node: string
  wrapper: string
  manifests: string[]
  extensionGeneration: string
  installedAt: number
}

interface Placement {
  distDir: string
  dataDir?: string
  home?: string
  platform?: NodeJS.Platform
}

export interface InstallOptions extends Placement {
  version: string
  userDataDirs?: readonly string[]
  node?: NodeCandidate
}

export interface InstallReport {
  version: string
  node: string
  wrapper: string
  extensionDir: string
  targets: HostTarget[]
}

function resolvePlacement(options: { dataDir?: string; home?: string; platform?: NodeJS.Platform }) {
  const dataDir = options.dataDir ?? DATA_DIR
  const hostDir = nativeHostDir(dataDir)
  return {
    dataDir,
    hostDir,
    wrapper: join(hostDir, WRAPPER_NAME),
    extensionDir: installedExtensionDir(dataDir),
    home: options.home ?? homedir(),
    platform: options.platform ?? process.platform,
  }
}

function probeNode(path: string): NodeCandidate {
  if (path === process.execPath) return { path, version: process.version }
  const run = spawnSync(path, ['-p', 'process.version'], { encoding: 'utf8', timeout: 10_000, env: {} })
  const version = run.status === 0 ? run.stdout.trim() : ''
  return { path, version: /^v\d+\.\d+\.\d+/.test(version) ? version : null }
}

export async function installCapture(options: InstallOptions): Promise<InstallReport> {
  const at = resolvePlacement(options)
  const previous = readRecordOrNull(at.dataDir)
  const choice = chooseHostNode(
    options.node ?? { path: process.execPath, version: process.version },
    previous ? probeNode(previous.node) : null,
  )
  if (!choice.ok) throw new CaptureInstallError(choice.reason, 'run it again with a newer node, for example through nvm')
  const targets = hostTargets({ home: at.home, platform: at.platform, hostName: HOST_NAME, explicit: options.userDataDirs })
  if (targets.length === 0) {
    throw new CaptureInstallError(
      at.platform === 'darwin' || at.platform === 'linux'
        ? 'found no Chromium browser to install for (Chrome, Chromium, Arc, Brave, Edge, Vivaldi)'
        : `installing the capture host on ${at.platform} is not supported yet`,
      'pass --user-data-dir <dir> to install into one browser profile',
    )
  }
  const bundle = join(options.distDir, 'native-host.mjs')
  if (!existsSync(bundle)) throw new CaptureInstallError(`this ezdesign has no native host at ${bundle}`)

  mkdirSync(at.hostDir, { recursive: true })
  const host = join(at.hostDir, HOST_BUNDLE)
  writeAtomic(host, readFileSync(bundle))
  writeAtomic(at.wrapper, hostWrapperScript({ node: choice.node.path, host, dataDir: at.dataDir }), 0o755)
  const extensionGeneration = installExtension(join(options.distDir, 'extension'), at.extensionDir)
  const manifest = `${JSON.stringify(hostManifest(at.wrapper, ALLOWED_ORIGINS), null, 2)}\n`
  for (const target of targets) {
    mkdirSync(dirname(target.manifestPath), { recursive: true })
    writeAtomic(target.manifestPath, manifest)
  }
  const record: InstallRecord = {
    version: options.version,
    node: choice.node.path,
    wrapper: at.wrapper,
    manifests: [...new Set([...(previous?.manifests ?? []), ...targets.map((t) => t.manifestPath)])],
    extensionGeneration,
    installedAt: Date.now(),
  }
  writeAtomic(join(at.hostDir, INSTALL_RECORD), `${JSON.stringify(record, null, 2)}\n`)
  return { version: options.version, node: choice.node.path, wrapper: at.wrapper, extensionDir: at.extensionDir, targets }
}

export interface UninstallOptions {
  dataDir?: string
  home?: string
  platform?: NodeJS.Platform
  userDataDirs?: readonly string[]
}

export interface UninstallReport {
  removedManifests: string[]
  keptManifests: string[]
}

function manifestPointsAt(manifestPath: string): string | null {
  try {
    const path = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { path?: unknown }).path
    return typeof path === 'string' ? path : null
  } catch {
    return null
  }
}

export async function uninstallCapture(options: UninstallOptions = {}): Promise<UninstallReport> {
  const at = resolvePlacement(options)
  const recorded = readRecordOrNull(at.dataDir)?.manifests ?? []
  const scanned = hostTargets({ home: at.home, platform: at.platform, hostName: HOST_NAME, explicit: options.userDataDirs })
  const report: UninstallReport = { removedManifests: [], keptManifests: [] }
  for (const manifestPath of new Set([...recorded, ...scanned.map((t) => t.manifestPath)])) {
    if (!existsSync(manifestPath)) continue
    if (manifestPointsAt(manifestPath) === at.wrapper) {
      rmSync(manifestPath, { force: true })
      report.removedManifests.push(manifestPath)
    } else {
      report.keptManifests.push(manifestPath)
    }
  }
  rmSync(at.hostDir, { recursive: true, force: true })
  rmSync(at.extensionDir, { recursive: true, force: true })
  return report
}

export type HostProblem =
  | { type: 'not-installed' }
  | { type: 'record-unreadable'; message: string }
  | { type: 'node-missing'; node: string }
  | { type: 'node-too-old'; node: string; version: string }
  | { type: 'stale'; installed: string; running: string }
  | { type: 'files-missing'; path: string }
  | { type: 'manifest-missing'; manifestPath: string }
  | { type: 'manifest-foreign'; manifestPath: string; points: string | null }

export interface CaptureStatus {
  record: InstallRecord | null
  extensionDir: string
  libraryDir: string
  targets: { target: HostTarget; installed: boolean }[]
  problems: HostProblem[]
}

export async function captureStatus(options: Placement & { version: string }): Promise<CaptureStatus> {
  const at = resolvePlacement(options)
  const status: CaptureStatus = {
    record: null,
    extensionDir: at.extensionDir,
    libraryDir: libraryDir(at.dataDir),
    targets: [],
    problems: [],
  }
  try {
    status.record = readInstallRecord(at.dataDir)
  } catch (error) {
    status.problems.push({ type: 'record-unreadable', message: (error as Error).message })
  }
  const found = hostTargets({ home: at.home, platform: at.platform, hostName: HOST_NAME })
  const recorded = status.record?.manifests ?? []
  const known = new Map(found.map((t) => [t.manifestPath, t]))
  for (const manifestPath of recorded) {
    if (!known.has(manifestPath)) {
      known.set(manifestPath, { browser: null, userDataDir: dirname(dirname(manifestPath)), manifestPath })
    }
  }
  for (const target of known.values()) {
    status.targets.push({ target, installed: manifestPointsAt(target.manifestPath) === at.wrapper })
  }
  const record = status.record
  if (!record) {
    if (status.problems.length === 0) status.problems.push({ type: 'not-installed' })
    return status
  }
  const node = probeNode(record.node)
  if (node.version === null) status.problems.push({ type: 'node-missing', node: record.node })
  else if (compareVersions(node.version, HOST_NODE_FLOOR) < 0) {
    status.problems.push({ type: 'node-too-old', node: record.node, version: node.version })
  }
  if (compareVersions(record.version, options.version) < 0) {
    status.problems.push({ type: 'stale', installed: record.version, running: options.version })
  }
  for (const path of [join(at.hostDir, HOST_BUNDLE), at.wrapper, join(at.extensionDir, 'manifest.json')]) {
    if (!existsSync(path)) status.problems.push({ type: 'files-missing', path })
  }
  for (const manifestPath of recorded) {
    if (!existsSync(manifestPath)) status.problems.push({ type: 'manifest-missing', manifestPath })
    else if (manifestPointsAt(manifestPath) !== at.wrapper) {
      status.problems.push({ type: 'manifest-foreign', manifestPath, points: manifestPointsAt(manifestPath) })
    }
  }
  return status
}

export type RefreshOutcome = 'not-installed' | 'current' | 'newer-installed' | 'refreshed'

export async function refreshCaptureInstall(options: Placement & { version: string }): Promise<RefreshOutcome> {
  const record = readInstallRecord(options.dataDir)
  if (!record) return 'not-installed'
  const order = compareVersions(record.version, options.version)
  if (order > 0) return 'newer-installed'
  const at = resolvePlacement(options)
  const intact =
    existsSync(join(at.hostDir, HOST_BUNDLE)) &&
    existsSync(at.wrapper) &&
    currentGeneration(at.extensionDir) === record.extensionGeneration &&
    // One version can be built twice with a different extension: the generation is its content.
    record.extensionGeneration === currentGeneration(join(options.distDir, 'extension'))
  if (order === 0 && intact) return 'current'
  const userDataDirs = record.manifests.map((m) => dirname(dirname(m))).filter((dir) => existsSync(dir))
  await installCapture({ ...options, userDataDirs })
  return 'refreshed'
}

export function readInstallRecord(dataDir: string = DATA_DIR): InstallRecord | null {
  const path = join(nativeHostDir(dataDir), INSTALL_RECORD)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const record = (() => {
    try {
      return JSON.parse(text) as Partial<InstallRecord>
    } catch {
      return null
    }
  })()
  if (
    !record ||
    typeof record.version !== 'string' ||
    typeof record.node !== 'string' ||
    typeof record.wrapper !== 'string' ||
    typeof record.extensionGeneration !== 'string' ||
    !Array.isArray(record.manifests)
  ) {
    throw new CaptureInstallError(`${path} is not a capture install record`, 'run `ezdesign extension install` to repair it')
  }
  return record as InstallRecord
}

function readRecordOrNull(dataDir: string): InstallRecord | null {
  try {
    return readInstallRecord(dataDir)
  } catch {
    return null
  }
}
