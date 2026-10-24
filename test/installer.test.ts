import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.EZDESIGN_DATA_DIR = mkdtempSync(join(tmpdir(), 'ezdesign-installer-'))

const { installedPackageRoot, npmErrorSummary, packageSpec, pruneInstalledVersions } = await import('../src/installer.js')
const { VERSIONS_DIR } = await import('../src/constants.js')

test('a self-update installs the scoped npm package under the data dir', () => {
  assert.equal(packageSpec('0.8.0'), '@cychien/ezdesign@0.8.0')
  assert.equal(
    installedPackageRoot('0.8.0'),
    join(process.env.EZDESIGN_DATA_DIR!, 'versions/0.8.0/node_modules/@cychien/ezdesign'),
  )
})

test('npmErrorSummary keeps what npm said and drops the noise around it', () => {
  const stderr = [
    'npm error code ETARGET',
    'npm error notarget No matching version found for @cychien/ezdesign@9.9.9.',
    'npm error notarget In most cases you or one of your dependencies are requesting',
    "npm error notarget a package version that doesn't exist.",
    'npm error A complete log of this run can be found in: /Users/x/.npm/_logs/1.log',
  ].join('\n')
  assert.equal(
    npmErrorSummary(stderr),
    'code ETARGET notarget No matching version found for @cychien/ezdesign@9.9.9.',
  )
  assert.equal(npmErrorSummary('something odd\nlast line'), 'last line')
  assert.equal(npmErrorSummary(''), '')
})

function installedVersion(version: string): string {
  const dir = join(installedPackageRoot(version), 'dist')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cli.mjs'), '')
  return join(dir, 'cli.mjs')
}

test('pruning keeps the version it runs from and drops the rest', () => {
  const running = installedVersion('0.7.0')
  installedVersion('0.6.1')
  installedVersion('0.5.0')
  pruneInstalledVersions(running)
  assert.deepEqual(readdirSync(VERSIONS_DIR), ['0.7.0'])
})

// The running path arrives already symlink-resolved (Node resolves the main
// entry), while the versions root is built from an env var and does not.
// Comparing the two as text made the daemon delete the tree it serves from -
// a data dir under macOS `/tmp` (a link to `/private/tmp`) is enough.
test('pruning compares real paths, so a symlinked data dir is not self-destructive', () => {
  const real = mkdtempSync(join(tmpdir(), 'ezdesign-real-'))
  const link = join(mkdtempSync(join(tmpdir(), 'ezdesign-link-')), 'data')
  symlinkSync(real, link)

  const viaLink = join(link, 'versions')
  const dir = join(viaLink, '0.7.0', 'node_modules', '@cychien', 'ezdesign', 'dist')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cli.mjs'), '')
  mkdirSync(join(viaLink, '0.6.1'), { recursive: true })

  // What the daemon passes in: its own entry, symlinks already resolved.
  const running = join(real, 'versions', '0.7.0', 'node_modules', '@cychien', 'ezdesign', 'dist', 'cli.mjs')
  pruneInstalledVersions(running, viaLink)
  assert.deepEqual(readdirSync(viaLink).sort(), ['0.7.0'])
})
