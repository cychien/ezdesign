import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { LOGIN_ENV_CACHE, LOGIN_ENV_VAR } from './constants.js'
import { writeAtomic } from './fs-atomic.js'
import { RUN_AS_NODE } from './self-node.js'

/** A macOS app started from Finder gets launchd's PATH, with no node, pnpm or
 *  agent CLI on it. */
export type LoginEnvOutcome =
  | { kind: 'inherited' }
  | { kind: 'already-resolved' }
  | { kind: 'cached' }
  | { kind: 'resolved'; shell: string; ms: number }
  | { kind: 'failed'; shell: string; error: string }

export const LOGIN_SHELL_TIMEOUT_MS = 10_000

export const PROCESS_LOCAL_VARS: ReadonlySet<string> = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD', LOGIN_ENV_VAR, RUN_AS_NODE])

interface LoginEnvCache {
  shell: string
  home: string
  env: Record<string, string>
}

let adopted: Promise<LoginEnvOutcome> | null = null

export function adoptLoginEnvironment(): Promise<LoginEnvOutcome> {
  adopted ??= resolveLoginEnvironment(process.env, LOGIN_ENV_CACHE)
  return adopted
}

export async function resolveLoginEnvironment(env: NodeJS.ProcessEnv, cacheFile: string): Promise<LoginEnvOutcome> {
  const request = env[LOGIN_ENV_VAR]
  if (!request) return { kind: 'inherited' }
  if (request === 'resolved') return { kind: 'already-resolved' }
  const shell = env.SHELL || '/bin/zsh'
  const home = env.HOME ?? ''
  const cached = readCache(cacheFile, shell, home)
  const fresh = dumpLoginShell(shell, env).then((dumped) => {
    if (dumped.env) cacheDump(cacheFile, { shell, home, env: dumped.env })
    return dumped
  })
  if (cached) {
    merge(env, cached)
    void fresh.catch(() => {})
    return { kind: 'cached' }
  }
  const started = Date.now()
  const dumped = await fresh
  if (!dumped.env) return { kind: 'failed', shell, error: dumped.error }
  merge(env, dumped.env)
  return { kind: 'resolved', shell, ms: Date.now() - started }
}

/** A cache that cannot be written only costs the next launch the wait. */
function cacheDump(file: string, cache: LoginEnvCache): void {
  try {
    writeAtomic(file, JSON.stringify(cache), 0o600)
  } catch {}
}

function merge(env: NodeJS.ProcessEnv, dump: Record<string, string>): void {
  for (const [key, value] of Object.entries(dump)) if (!PROCESS_LOCAL_VARS.has(key)) env[key] = value
  env[LOGIN_ENV_VAR] = 'resolved'
}

function readCache(file: string, shell: string, home: string): Record<string, string> | null {
  try {
    const cache = JSON.parse(readFileSync(file, 'utf8')) as LoginEnvCache
    return cache.shell === shell && cache.home === home && cache.env && typeof cache.env === 'object' ? cache.env : null
  } catch {
    return null
  }
}

function dumpLoginShell(shell: string, env: NodeJS.ProcessEnv): Promise<{ env: Record<string, string>; error?: undefined } | { env?: undefined; error: string }> {
  const marker = randomBytes(8).toString('hex')
  const { file, args } = loginShellInvocation(shell, marker)
  return new Promise((resolve) => {
    const minimal = { HOME: env.HOME ?? '', USER: env.USER ?? '', LOGNAME: env.LOGNAME ?? '', SHELL: shell, TERM: 'dumb' }
    const child = spawn(file, args, { env: minimal, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {}
    }, LOGIN_SHELL_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ error: error.message })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const dump = parseEnvDump(stdout, marker)
      resolve(dump ? { env: dump } : { error: `${shell} printed no environment within ${LOGIN_SHELL_TIMEOUT_MS / 1000} s` })
    })
  })
}

/** Bracketed by `marker`, so what an rc file prints is cut away; `env -0`
 *  because a value may hold newlines. */
export function loginShellInvocation(shell: string, marker: string): { file: string; args: string[] } {
  return { file: shell, args: ['-i', '-l', '-c', `printf %s ${marker}; /usr/bin/env -0; printf %s ${marker}`] }
}

export function parseEnvDump(stdout: string, marker: string): Record<string, string> | null {
  const first = stdout.indexOf(marker)
  const last = stdout.lastIndexOf(marker)
  if (first === -1 || last === first) return null
  const dump: Record<string, string> = {}
  for (const entry of stdout.slice(first + marker.length, last).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) dump[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return dump
}

export function findExecutable(binary: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binary)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}
