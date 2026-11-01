/** In the desktop app the daemon runs on Electron's embedded Node, where
 *  `process.execPath` is the app binary and only acts as Node with
 *  `ELECTRON_RUN_AS_NODE=1` in its environment. That variable is inherited by
 *  every child, so a dev server or an agent that runs Electron itself would start
 *  as a bare Node instead of an app. */

import { shellQuote } from './shell-quote.js'

export const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

export interface NodeRuntime {
  readonly execPath: string
  readonly env: Readonly<Record<string, string>>
}

const onElectron = Boolean(process.versions.electron) || process.env[RUN_AS_NODE] === '1'

export const SELF_NODE: NodeRuntime = {
  execPath: process.execPath,
  env: onElectron ? { [RUN_AS_NODE]: '1' } : {},
}

export function scrubRunAsNode(env: NodeJS.ProcessEnv = process.env): void {
  delete env[RUN_AS_NODE]
}

export function selfNodeCommandLine(args: readonly string[], runtime: NodeRuntime = SELF_NODE): string {
  const env = Object.entries(runtime.env).map(([k, v]) => `${k}=${shellQuote(v)}`)
  return [...env, ...[runtime.execPath, ...args].map(shellQuote)].join(' ')
}

export function selfNodeEnv(
  base: NodeJS.ProcessEnv = process.env,
  runtime: NodeRuntime = SELF_NODE,
): NodeJS.ProcessEnv {
  return { ...base, ...runtime.env }
}
