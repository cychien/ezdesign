import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallPart, MissingToolWire, UndecidedReason } from './wire.js'

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

export const LOCKFILES_BY_PRECEDENCE: readonly { file: string; manager: PackageManager }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'package-lock.json', manager: 'npm' },
]

export interface ProjectFacts {
  packageJson: {
    scripts: Readonly<Record<string, string>>
    packageManager?: string
    workspaces: boolean
  } | null
  lockfiles: readonly string[]
  pnpmWorkspace: boolean
}

export interface DetectedCommand {
  manager: PackageManager
  script: 'dev' | 'start'
  managerFrom: 'packageManager' | 'lockfile' | 'default'
}

export type Detection =
  | { kind: 'command'; command: DetectedCommand }
  | {
      kind: 'undecided'
      reason: UndecidedReason
      serverScripts: string[]
    }

/** Never throws: an unreadable or malformed `package.json` is a project without one. */
export function readProjectFacts(root: string): ProjectFacts {
  const isFile = (name: string) => statSync(join(root, name), { throwIfNoEntry: false })?.isFile() === true
  return {
    packageJson: readPackageJson(join(root, 'package.json')),
    lockfiles: LOCKFILES_BY_PRECEDENCE.filter((l) => isFile(l.file)).map((l) => l.file),
    pnpmWorkspace: isFile('pnpm-workspace.yaml'),
  }
}

function readPackageJson(file: string): ProjectFacts['packageJson'] {
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return null
  const { scripts, packageManager, workspaces } = pkg as Record<string, unknown>
  const named =
    scripts && typeof scripts === 'object'
      ? Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === 'string')
      : []
  return {
    scripts: Object.fromEntries(named),
    ...(typeof packageManager === 'string' ? { packageManager } : {}),
    workspaces:
      Array.isArray(workspaces) ||
      (!!workspaces && typeof workspaces === 'object' && Array.isArray((workspaces as { packages?: unknown }).packages)),
  }
}

const MANAGERS: readonly PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm']

const SERVER_LOOKING = /(^|[:_-])(dev|start|serve)([:_-]|$)/

export function detectDevCommand(facts: ProjectFacts): Detection {
  const pkg = facts.packageJson
  if (!pkg) return { kind: 'undecided', reason: 'no-package-json', serverScripts: [] }
  const script = 'dev' in pkg.scripts ? 'dev' : 'start' in pkg.scripts ? 'start' : null
  if (!script) {
    const serverScripts = Object.keys(pkg.scripts).filter((name) => SERVER_LOOKING.test(name))
    const atRoot = pkg.workspaces || facts.pnpmWorkspace
    return { kind: 'undecided', reason: atRoot ? 'monorepo-root' : 'no-script', serverScripts }
  }
  const fromField = MANAGERS.find((m) => pkg.packageManager?.split('@')[0] === m)
  if (fromField) return { kind: 'command', command: { manager: fromField, script, managerFrom: 'packageManager' } }
  const lock = LOCKFILES_BY_PRECEDENCE.find((l) => facts.lockfiles.includes(l.file))
  if (lock) return { kind: 'command', command: { manager: lock.manager, script, managerFrom: 'lockfile' } }
  return { kind: 'command', command: { manager: 'npm', script, managerFrom: 'default' } }
}

/** The shell line for a settled command. `npm start` and `npm run dev`, because
 *  npm runs only a few script names without `run`. */
export function commandLine(command: DetectedCommand): string {
  switch (command.manager) {
    case 'npm':
      return command.script === 'start' ? 'npm start' : 'npm run dev'
    case 'bun':
      return `bun run ${command.script}`
    default:
      return `${command.manager} ${command.script}`
  }
}

export function requiredTools(command: DetectedCommand): string[] {
  return command.manager === 'bun' ? ['bun'] : [command.manager, 'node']
}

export function toolsForLine(line: string): string[] {
  const first = line.trim().split(/\s+/)[0] ?? ''
  if (!/^[\w.+-]+$/.test(first)) return []
  return ['npm', 'npx', 'pnpm', 'yarn'].includes(first) ? [first, 'node'] : [first]
}

const parts = (...items: (string | { command: string })[]): InstallPart[] =>
  items.map((item) => (typeof item === 'string' ? { text: item } : item))
const run = (command: string) => ({ command })

const INSTALL: Readonly<Record<string, InstallPart[]>> = {
  node: parts('從 https://nodejs.org 安裝 Node.js，或執行 ', run('brew install node')),
  npm: parts('npm 隨 Node.js 一起安裝：從 https://nodejs.org 安裝 Node.js'),
  pnpm: parts('執行 ', run('corepack enable pnpm'), '，或 ', run('npm install -g pnpm')),
  yarn: parts('執行 ', run('corepack enable yarn'), '，或 ', run('npm install -g yarn')),
  bun: parts('執行 ', run('curl -fsSL https://bun.sh/install | bash'), '，或 ', run('brew install oven-sh/bun/bun')),
}

export function missingTools(
  tools: readonly string[],
  findOnPath: (binary: string) => string | null,
): MissingToolWire[] {
  return tools
    .filter((tool) => findOnPath(tool) === null)
    .map((tool) => ({ tool, install: INSTALL[tool] ?? parts('安裝 ', run(tool), '，並確認登入 shell 的 PATH 找得到它') }))
}
