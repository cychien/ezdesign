import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Initiator } from '../src/dev-server/index.js'
import { ProjectBook } from '../src/projects/book.js'
import { type HubRuntime, ProjectHub } from '../src/projects/hub.js'

type FakeRuntime = HubRuntime & { agentBy: Initiator | null }

function runtime(project: string, agentBy: Initiator | null): FakeRuntime {
  const fake = {
    project,
    agentBy,
    devServer: { summary: () => ({ phase: 'idle' }), ensure: () => {}, stop: async () => {}, external: false, managedBy: null },
    shellUrl: () => `http://127.0.0.1:1/${project}`,
    disconnectAgentOf(by: Initiator): boolean {
      if (fake.agentBy !== by) return false
      fake.agentBy = null
      return true
    },
  }
  return fake as unknown as FakeRuntime
}

test('the app’s quit disconnects the agents its windows connected, and only those', () => {
  const sessions = [runtime('/a', 'desktop'), runtime('/b', 'browser'), runtime('/c', null), runtime('/d', 'desktop')]
  const hub = new ProjectHub({
    sessions: { list: () => sessions, open: async () => ({ ok: false }) as never },
    book: new ProjectBook([], join(mkdtempSync(join(tmpdir(), 'ezdesign-hub-')), 'projects.json')),
    version: '0.0.0',
    account: () => ({ email: null }),
    defaultAgent: () => 'agent',
    projectRoot: (path) => path,
    restored: async () => {},
  })
  assert.equal(hub.disconnectAgentsOf('desktop'), 2)
  assert.deepEqual(
    sessions.map((s) => s.agentBy),
    [null, 'browser', null, null],
  )
})
