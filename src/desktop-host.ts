import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HOME_PATH, LOGIN_ENV_VAR, VERSIONS_DIR } from './constants.js'
import { DESKTOP_CONTRACT, DESKTOP_HEADER, type DesktopOpenAnswer, type DesktopQuitAnswer } from './desktop-wire.js'
import { installedPackageRoot } from './installer.js'
import { type DaemonLaunch, type RunningDaemon, ensureDaemonWhere, findRunningDaemon } from './registry.js'
import type { NodeRuntime } from './self-node.js'
import { isNewer } from './update-check.js'

export type PackageSource =
  | { kind: 'bundled'; prefix: string; version: string }
  | { kind: 'checkout'; cliEntry: string; version: string }

export interface AttachOptions {
  source: PackageSource
  runtime: NodeRuntime
}

export interface AttachedDaemon {
  port: number
  pid: number
  version: string
  homeUrl: string
  control: DesktopControl
}

export async function attachDaemon(opts: AttachOptions): Promise<AttachedDaemon> {
  const launch = async (): Promise<DaemonLaunch> => ({
    cliEntry: await cliEntryFor(opts.source),
    runtime: opts.runtime,
    env: { [LOGIN_ENV_VAR]: 'resolve' },
  })
  const running = await ensureDaemonWhere(launch, speaksContract)
  return {
    port: running.port,
    pid: running.pid,
    version: running.version,
    homeUrl: homeUrlFor(running.port),
    control: new DesktopControl(running.port),
  }
}

export async function currentDaemon(): Promise<{ port: number; speaksContract: boolean } | null> {
  const running = await findRunningDaemon()
  return running ? { port: running.port, speaksContract: speaksContract(running) } : null
}

export const homeUrlFor = (port: number) => `http://127.0.0.1:${port}${HOME_PATH}`

export function speaksContract(daemon: Pick<RunningDaemon, 'desktopContract'>): boolean {
  return (daemon.desktopContract ?? 0) >= DESKTOP_CONTRACT
}

async function cliEntryFor(source: PackageSource): Promise<string> {
  if (source.kind === 'checkout') return source.cliEntry
  await seedBundledPackage(source.prefix, source.version)
  return join(installedPackageRoot(newestInstalled(source.version)), 'dist', 'cli.mjs')
}

export async function seedBundledPackage(prefix: string, version: string): Promise<void> {
  if (installedVersion(version)) return
  mkdirSync(VERSIONS_DIR, { recursive: true })
  const temp = join(VERSIONS_DIR, `.${version}.seed-${process.pid}`)
  rmSync(temp, { recursive: true, force: true })
  await promisify(execFile)('/bin/cp', ['-cR', prefix, temp])
  const target = join(VERSIONS_DIR, version)
  try {
    rmSync(target, { recursive: true, force: true })
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { recursive: true, force: true })
    if (!installedVersion(version)) throw error
  }
}

export function installedVersion(version: string): boolean {
  const root = installedPackageRoot(version)
  if (!existsSync(join(root, 'dist', 'cli.mjs'))) return false
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version === version
  } catch {
    return false
  }
}

export function newestInstalled(floor: string, versions: readonly string[] = listVersions()): string {
  return versions.filter(installedVersion).reduce((best, v) => (isNewer(v, best) ? v : best), floor)
}

function listVersions(): string[] {
  try {
    return readdirSync(VERSIONS_DIR).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}

export class DesktopControl {
  constructor(readonly port: number) {}

  async open(path: string): Promise<DesktopOpenAnswer> {
    const res = await this.post('open', { path })
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${res.status}`)
    return (await res.json()) as DesktopOpenAnswer
  }

  async quit(timeoutMs = 5_000): Promise<DesktopQuitAnswer | null> {
    try {
      const res = await this.post('quit', {}, AbortSignal.timeout(timeoutMs))
      return res.ok ? ((await res.json()) as DesktopQuitAnswer) : null
    } catch {
      return null
    }
  }

  private post(route: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}/control/desktop/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [DESKTOP_HEADER]: String(DESKTOP_CONTRACT) },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  }
}
