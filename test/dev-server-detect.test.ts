import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  type Detection,
  commandLine,
  detectDevCommand,
  missingTools,
  readProjectFacts,
  requiredTools,
  toolsForLine,
} from '../src/dev-server/detect.js'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'dev-command')

const detect = (name: string) => detectDevCommand(readProjectFacts(join(FIXTURES, name)))

const cases: [string, Detection][] = [
  ['npm-dev', { kind: 'command', command: { manager: 'npm', script: 'dev', managerFrom: 'lockfile' } }],
  ['pnpm-start', { kind: 'command', command: { manager: 'pnpm', script: 'start', managerFrom: 'lockfile' } }],
  ['yarn-dev', { kind: 'command', command: { manager: 'yarn', script: 'dev', managerFrom: 'lockfile' } }],
  ['bun-dev', { kind: 'command', command: { manager: 'bun', script: 'dev', managerFrom: 'lockfile' } }],
  ['field-vs-lockfile', { kind: 'command', command: { manager: 'pnpm', script: 'dev', managerFrom: 'packageManager' } }],
  ['field-unknown', { kind: 'command', command: { manager: 'yarn', script: 'dev', managerFrom: 'lockfile' } }],
  ['workspace-dev', { kind: 'command', command: { manager: 'pnpm', script: 'dev', managerFrom: 'lockfile' } }],
  ['workspace-root', { kind: 'undecided', reason: 'monorepo-root', serverScripts: [] }],
  ['several-scripts', { kind: 'undecided', reason: 'no-script', serverScripts: ['dev:web', 'dev:api'] }],
  ['no-script', { kind: 'undecided', reason: 'no-script', serverScripts: [] }],
  ['not-node', { kind: 'undecided', reason: 'no-package-json', serverScripts: [] }],
]

for (const [name, expected] of cases) {
  test(`detects ${name}`, () => {
    assert.deepEqual(detect(name), expected)
  })
}

test('spells each manager the way it runs a script', () => {
  assert.equal(commandLine({ manager: 'npm', script: 'dev', managerFrom: 'default' }), 'npm run dev')
  assert.equal(commandLine({ manager: 'npm', script: 'start', managerFrom: 'default' }), 'npm start')
  assert.equal(commandLine({ manager: 'pnpm', script: 'dev', managerFrom: 'lockfile' }), 'pnpm dev')
  assert.equal(commandLine({ manager: 'yarn', script: 'start', managerFrom: 'lockfile' }), 'yarn start')
  assert.equal(commandLine({ manager: 'bun', script: 'dev', managerFrom: 'lockfile' }), 'bun run dev')
})

test('a stored line needs its first word, and node behind a Node package manager', () => {
  assert.deepEqual(toolsForLine('pnpm --filter web dev'), ['pnpm', 'node'])
  assert.deepEqual(toolsForLine('  bun run dev'), ['bun'])
  assert.deepEqual(toolsForLine('python3 -m http.server'), ['python3'])
  assert.deepEqual(toolsForLine('PORT=3000 next dev'), [])
  assert.deepEqual(toolsForLine('./bin/serve'), [])
})

test('a detected command needs its manager, and node unless it is bun', () => {
  assert.deepEqual(requiredTools({ manager: 'pnpm', script: 'dev', managerFrom: 'lockfile' }), ['pnpm', 'node'])
  assert.deepEqual(requiredTools({ manager: 'bun', script: 'dev', managerFrom: 'lockfile' }), ['bun'])
})

test('missing tools come with the line that installs them', () => {
  const onPath = new Set(['node'])
  assert.deepEqual(
    missingTools(['pnpm', 'node', 'deno'], (b) => (onPath.has(b) ? `/bin/${b}` : null)),
    [
      {
        tool: 'pnpm',
        install: [{ text: '執行 ' }, { command: 'corepack enable pnpm' }, { text: '，或 ' }, { command: 'npm install -g pnpm' }],
      },
      { tool: 'deno', install: [{ text: '安裝 ' }, { command: 'deno' }, { text: '，並確認登入 shell 的 PATH 找得到它' }] },
    ],
  )
})

test('an unreadable package.json is a project without one', () => {
  assert.deepEqual(detectDevCommand({ packageJson: null, lockfiles: ['pnpm-lock.yaml'], pnpmWorkspace: false }), {
    kind: 'undecided',
    reason: 'no-package-json',
    serverScripts: [],
  })
})

test('no lockfile and no field is npm by default', () => {
  assert.deepEqual(detectDevCommand({ packageJson: { scripts: { start: 'node .' }, workspaces: false }, lockfiles: [], pnpmWorkspace: false }), {
    kind: 'command',
    command: { manager: 'npm', script: 'start', managerFrom: 'default' },
  })
})
