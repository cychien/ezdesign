import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loginShellInvocation, parseEnvDump, resolveLoginEnvironment } from '../src/login-env.js'

const dir = () => mkdtempSync(join(tmpdir(), 'ezdesign-login-env-'))

function fakeShell(path: string): string {
  const shell = join(dir(), 'fake-shell')
  writeFileSync(
    shell,
    `#!/bin/sh\necho "Welcome back!"\nexport PATH='${path}' NVM_DIR=/home/u/.nvm SHLVL=9\neval "$4"\n`,
  )
  chmodSync(shell, 0o755)
  return shell
}

test('the dump is read between its markers, values with newlines included', () => {
  const out = 'motd line\nMARKa=1\0B=two\nlines\0bad-entry\0=empty\0MARKtrailing'
  assert.deepEqual(parseEnvDump(out, 'MARK'), { a: '1', B: 'two\nlines' })
  assert.equal(parseEnvDump('no markers here', 'MARK'), null)
  assert.equal(parseEnvDump('MARK only one', 'MARK'), null)
})

test('the shell runs as a login, interactive shell and prints the dump bracketed', () => {
  assert.deepEqual(loginShellInvocation('/bin/zsh', 'M'), {
    file: '/bin/zsh',
    args: ['-i', '-l', '-c', 'printf %s M; /usr/bin/env -0; printf %s M'],
  })
})

test('a terminal-started daemon keeps its environment', async () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
  assert.deepEqual(await resolveLoginEnvironment(env, join(dir(), 'cache.json')), { kind: 'inherited' })
  assert.deepEqual(env, { PATH: '/usr/bin' })
})

test("the app's daemon takes the login PATH, keeps its own bookkeeping, and caches it privately", async () => {
  const cache = join(dir(), 'login-env.json')
  const env: NodeJS.ProcessEnv = {
    HOME: '/home/u',
    SHELL: fakeShell('/home/u/.nvm/versions/node/v22/bin:/usr/bin:/bin'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHLVL: '1',
    EZDESIGN_LOGIN_ENV: 'resolve',
  }
  const outcome = await resolveLoginEnvironment(env, cache)
  assert.equal(outcome.kind, 'resolved')
  assert.equal(env.PATH, '/home/u/.nvm/versions/node/v22/bin:/usr/bin:/bin')
  assert.equal(env.NVM_DIR, '/home/u/.nvm')
  assert.equal(env.SHLVL, '1', 'the shell’s own bookkeeping is not ours')
  assert.equal(env.EZDESIGN_LOGIN_ENV, 'resolved', 'a successor inherits the result')
  assert.equal(statSync(cache).mode & 0o777, 0o600)
  assert.equal((JSON.parse(readFileSync(cache, 'utf8')) as { env: { PATH: string } }).env.PATH, env.PATH)

  const next: NodeJS.ProcessEnv = { HOME: '/home/u', SHELL: env.SHELL, PATH: '/usr/bin', EZDESIGN_LOGIN_ENV: 'resolve' }
  assert.deepEqual(await resolveLoginEnvironment(next, cache), { kind: 'cached' })
  assert.equal(next.PATH, '/home/u/.nvm/versions/node/v22/bin:/usr/bin:/bin', 'a later launch does not wait for the shell')
})

test('a successor across a self-update does not run the shell again', async () => {
  const env: NodeJS.ProcessEnv = { EZDESIGN_LOGIN_ENV: 'resolved', PATH: '/x' }
  assert.deepEqual(await resolveLoginEnvironment(env, join(dir(), 'cache.json')), { kind: 'already-resolved' })
})

test('a shell that prints nothing is a failure, and the daemon carries on', async () => {
  const shell = join(dir(), 'broken-shell')
  writeFileSync(shell, '#!/bin/sh\nexit 1\n')
  chmodSync(shell, 0o755)
  const env: NodeJS.ProcessEnv = { HOME: '/h', SHELL: shell, PATH: '/usr/bin', EZDESIGN_LOGIN_ENV: 'resolve' }
  const outcome = await resolveLoginEnvironment(env, join(dir(), 'cache.json'))
  assert.equal(outcome.kind, 'failed')
  assert.equal(env.PATH, '/usr/bin')
})
