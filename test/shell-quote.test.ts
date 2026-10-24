import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { shellQuote } from '../src/shell-quote.js'

// Proven through a real shell rather than against an expected string: the point
// is that the argument arrives whole, not that it is escaped a particular way.
test('shellQuote survives a round trip through the shell it is quoting for', {
  skip: process.platform === 'win32' ? 'POSIX quoting' : false,
}, () => {
  for (const arg of [
    '/Users/John Smith/.ezdesign/versions/0.7.0',
    "/tmp/it's here/x",
    '/tmp/a$HOME/b',
    '/tmp/a&b;c/d',
    '/tmp/back\\slash',
    '@cychien/ezdesign@0.7.0',
    '--no-audit',
  ]) {
    const out = spawnSync('sh', ['-c', `printf %s ${shellQuote(arg)}`], { encoding: 'utf8' })
    assert.equal(out.status, 0, arg)
    assert.equal(out.stdout, arg, arg)
  }
})
