import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AGENT_PROFILES } from '../src/agents.js'
import { parseProposalReply, projectRelativePath, proposalPrompt, proposingAgent } from '../src/dev-server/proposal.js'

test('the last fenced json block is the answer', () => {
  const reply = 'I looked.\n```json\n{"command": "pnpm dev", "cwd": "."}\n```\nOn second thought:\n```json\n{"command": "pnpm --filter web dev", "cwd": "apps/web", "reason": "the site"}\n```'
  assert.deepEqual(parseProposalReply(reply), { kind: 'command', line: 'pnpm --filter web dev', cwd: 'apps/web', reason: 'the site' })
})

test('no web app is an answer too', () => {
  assert.deepEqual(parseProposalReply('```json\n{"command": null, "reason": "a CLI tool"}\n```'), { kind: 'none', reason: 'a CLI tool' })
})

test('anything else is not an answer', () => {
  for (const reply of [
    'no block at all',
    '```json\nnot json\n```',
    '```json\n{"command": "pnpm dev\\nrm -rf ~"}\n```',
    '```json\n{"command": ""}\n```',
    `\`\`\`json\n{"command": "${'x'.repeat(501)}"}\n\`\`\``,
    '```json\n{"command": "pnpm dev", "cwd": "/etc"}\n```',
    '```json\n{"command": 42}\n```',
  ]) {
    assert.equal(parseProposalReply(reply), null, reply)
  }
})

test('a folder is the project or inside it, symlinks resolved', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ezdesign-proposal-')))
  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  assert.equal(projectRelativePath(root, '.'), '')
  assert.equal(projectRelativePath(root, 'apps/web'), join('apps', 'web'))
  assert.equal(projectRelativePath(root, '../'), null)
  assert.equal(projectRelativePath(root, 'apps/missing'), null)
  assert.equal(projectRelativePath(root, '/tmp'), null)
})

test('the question says what the rules found and fixes the answer’s shape', () => {
  const prompt = proposalPrompt({
    project: '/code/site',
    facts: { packageJson: { scripts: { 'dev:web': 'vite' }, workspaces: false }, lockfiles: ['pnpm-lock.yaml'], pnpmWorkspace: false },
    undecided: { kind: 'undecided', reason: 'no-script', serverScripts: ['dev:web'] },
  })
  assert.match(prompt, /propose the command that starts this project's dev server, from \/code\/site/)
  assert.match(prompt, /neither a "dev" nor a "start" script/)
  assert.match(prompt, /- dev:web: vite/)
  assert.match(prompt, /Lockfiles: pnpm-lock.yaml/)
  assert.match(prompt, /do not run anything/)
  assert.match(prompt, /```json\n\{"command": "pnpm --filter web dev", "cwd": ".", "reason": "one sentence"\}\n```/)
})

test('the agent asked is the first that can run, and none when no agent is installed', () => {
  const [claude, codex] = AGENT_PROFILES.map((p) => p.command)
  const only = (...ids: string[]) => (p: { id: string }) => ids.includes(p.id)
  assert.equal(proposingAgent([codex, claude], only('claude', 'codex')), codex)
  assert.equal(proposingAgent([undefined, codex], only('claude')), claude, 'an uninstalled pick falls to an installed one')
  assert.equal(proposingAgent(['node my-agent.mjs'], only()), 'node my-agent.mjs', 'a command of no known agent is the user’s to vouch for')
  assert.equal(proposingAgent([claude, codex], only()), null)
})
