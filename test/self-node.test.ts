import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { SELF_NODE, scrubRunAsNode, selfNodeCommandLine, selfNodeEnv } from '../src/self-node.js'
import { shellQuote } from '../src/shell-quote.js'

const FLAG = ['ELECTRON', 'RUN', 'AS', 'NODE'].join('_')

const words = (line: string) =>
  JSON.parse(execFileSync('/bin/sh', ['-c', `${process.execPath} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- ${line}`], { encoding: 'utf8' })) as string[]

test('on a system Node, SELF_NODE is this node with nothing added', () => {
  assert.equal(SELF_NODE.execPath, process.execPath)
  assert.deepEqual(SELF_NODE.env, {})
})

test("the agent's ezdesign line splits into the words the old one did", () => {
  const args = ['--import', 'tsx', '/Users/x y/.ezdesign/versions/0.9.2/dist/cli.mjs']
  const before = [process.execPath, ...args].map(shellQuote).join(' ')
  assert.deepEqual(words(selfNodeCommandLine(args)), words(before))
})

test('the spawn environment is the caller’s, unchanged', () => {
  const base = { PATH: '/usr/bin', HOME: '/h' }
  assert.deepEqual(selfNodeEnv(base), base)
})

test('scrubbing takes the flag out and leaves the rest', () => {
  const env: NodeJS.ProcessEnv = { [FLAG]: '1', PATH: '/usr/bin' }
  scrubRunAsNode(env)
  assert.deepEqual(env, { PATH: '/usr/bin' })
  scrubRunAsNode(env)
  assert.deepEqual(env, { PATH: '/usr/bin' })
})
