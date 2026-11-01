import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { ROOT } from './helpers/imports.js'
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

test("on Electron's Node the flag reaches its own Node children and no other child", async (t) => {
  const electron = electronBinary()
  if (!electron) return t.skip('the desktop workspace is not installed')
  const dir = mkdtempSync(join(tmpdir(), 'ezdesign-self-node-'))
  const driver = join(dir, 'driver.ts')
  writeFileSync(
    driver,
    `import { execFileSync } from 'node:child_process'
import { SELF_NODE, scrubRunAsNode, selfNodeEnv } from ${JSON.stringify(join(ROOT, 'src', 'self-node.ts'))}
const env = SELF_NODE.env
scrubRunAsNode()
const own = execFileSync(SELF_NODE.execPath, ['-p', 'process.versions.node'], { env: selfNodeEnv(), encoding: 'utf8' }).trim()
const plain = execFileSync('/usr/bin/env', { encoding: 'utf8' })
console.log(JSON.stringify({ env, own, plainHasFlag: plain.includes('${FLAG}=') }))
`,
  )
  const bundle = join(dir, 'driver.mjs')
  await build({ entryPoints: [driver], outfile: bundle, bundle: true, platform: 'node', format: 'esm' })
  const out = execFileSync(electron, [bundle], { env: { ...process.env, [FLAG]: '1' }, encoding: 'utf8' })
  const result = JSON.parse(out.trim().split('\n').at(-1)!) as { env: Record<string, string>; own: string; plainHasFlag: boolean }
  assert.deepEqual(result.env, { [FLAG]: '1' })
  assert.match(result.own, /^\d+\.\d+\.\d+$/, 'the app binary ran as Node, not as an app')
  assert.equal(result.plainHasFlag, false, 'a dev server or agent never inherits it')
})

function electronBinary(): string | null {
  try {
    const path = createRequire(join(ROOT, 'desktop', 'package.json'))('electron') as string
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}
