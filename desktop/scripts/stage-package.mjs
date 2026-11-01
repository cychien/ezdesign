import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve('..')
const stage = resolve('stage')
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: 'inherit', ...opts })

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
run('npm', ['run', 'build'], { cwd: root })
run('npm', ['pack', '--pack-destination', stage], { cwd: root })
const tarball = join(stage, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)
const prefix = join(stage, 'ezdesign')
run('npm', ['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', tarball])
rmSync(tarball)

const cli = join(prefix, 'node_modules', name, 'dist', 'cli.mjs')
const electron = join('node_modules', '.bin', 'electron')
const printed = execFileSync(electron, [cli, '--version'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }).trim()
if (printed !== version) throw new Error(`staged CLI printed ${printed}, expected ${version}`)
console.log(`staged ${name}@${version} in ${prefix}`)
