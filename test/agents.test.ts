import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { AGENT_PROFILES, agentCommand, launchCommand } from '../src/agents.js'

test("a profile's adapter is fetched under ezdesign's own npm prefix, never resolved from the project", () => {
  assert.equal(
    launchCommand(agentCommand('claude'), '/data/acp'),
    'npx -y --prefix /data/acp @agentclientprotocol/claude-agent-acp',
  )
  assert.equal(launchCommand(agentCommand('codex'), '/data/acp'), 'npx -y --prefix /data/acp @agentclientprotocol/codex-acp')
  for (const profile of AGENT_PROFILES.filter((p) => p.adapter)) {
    assert.ok(profile.command.endsWith(` ${profile.adapter}`), profile.id)
  }
})

test('a command that is not a profile adapter runs exactly as given', () => {
  assert.equal(launchCommand(agentCommand('gemini'), '/data/acp'), 'gemini --experimental-acp')
  const custom = 'npx -y @agentclientprotocol/claude-agent-acp@0.95.0'
  assert.equal(launchCommand(custom, '/data/acp'), custom)
})

test('a prefix with a space in it reaches npx whole', { skip: process.platform === 'win32' ? 'POSIX shell' : false }, () => {
  const prefix = '/Users/John Smith/.ezdesign/acp'
  const line = launchCommand(agentCommand('claude'), prefix).replace(/^npx /, 'printf "%s\\n" ')
  const out = spawnSync('sh', ['-c', line], { encoding: 'utf8' })
  assert.deepEqual(out.stdout.trim().split('\n'), ['-y', '--prefix', prefix, '@agentclientprotocol/claude-agent-acp'])
})
