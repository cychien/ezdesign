import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }

async function bundle(entry: string, name: string): Promise<string> {
  const outfile = join(REPO, 'dist', `.node-floor-${process.pid}-${name}`)
  await build({
    entryPoints: [join(REPO, entry)],
    outfile,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    bundle: true,
    packages: 'external',
    logLevel: 'silent',
  })
  return outfile
}

test('CX-p1-no-sqlite-cli: a node without node:sqlite still runs every command but the library', async (t) => {
  const cli = await bundle('src/cli.ts', 'cli.mjs')
  const vite = await bundle('src/vite.ts', 'vite.mjs')
  t.after(() => [cli, vite].forEach((f) => rmSync(f, { force: true })))
  const home = mkdtempSync(join(tmpdir(), 'ezdesign-no-sqlite-'))
  const env = { PATH: process.env.PATH, HOME: home, EZDESIGN_DATA_DIR: join(home, 'data'), EZDESIGN_NO_UPDATE_CHECK: '1' }
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--no-experimental-sqlite', ...args], { env, cwd: REPO, encoding: 'utf8' })
  const nodeNoise = (stderr: string) => stderr.split('\n').filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l))

  const versionRun = run(cli, '--version')
  assert.deepEqual([versionRun.status, versionRun.stdout.trim(), nodeNoise(versionRun.stderr)], [0, version, []])
  const status = run(cli, 'status')
  assert.deepEqual([status.status, status.stdout.trim(), nodeNoise(status.stderr)], [0, 'daemon: not running', []])
  const plugin = run('--input-type=module', '-e', `await import(${JSON.stringify(vite)})`)
  assert.deepEqual([plugin.status, nodeNoise(plugin.stderr)], [0, []])
  assert.equal(existsSync(join(home, 'data')), false)

  const library = run(
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    `import { openLibrary } from ${JSON.stringify(join(REPO, 'src/library/index.ts'))}
     try { await openLibrary(); console.log('opened') } catch (e) { console.log(JSON.stringify([e.name, e.code, e.message])) }`,
  )
  const [name, code, message] = JSON.parse(library.stdout) as string[]
  assert.deepEqual([name, code], ['LibraryError', 'node-too-old'])
  assert.match(message!, /22\.13/)
  assert.equal(existsSync(join(home, 'data')), false, 'the refusal leaves no trace')
})
