import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DOWNLOAD, REPO } from '../website/src/lib/links.js'

const builder = readFileSync(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8')
const field = (name: string) => new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm').exec(builder)?.[1]?.trim()

test("the website's download links name the DMGs the build makes, under the newest release", () => {
  assert.equal(field('artifactName'), 'ezdesign-${arch}.dmg')
  assert.deepEqual(DOWNLOAD, {
    arm64: `${REPO}/releases/latest/download/ezdesign-arm64.dmg`,
    x64: `${REPO}/releases/latest/download/ezdesign-x64.dmg`,
  })
  assert.equal(`https://github.com/${field('owner')}/${field('repo')}`, REPO)
})

test("the app's release tags never take the npm package's", () => {
  assert.equal(field('tagNamePrefix'), 'desktop-v')
})

test('the daemon can still run on the app binary, and nothing else widens what it runs', () => {
  assert.equal(field('runAsNode'), 'true')
  assert.equal(field('enableNodeOptionsEnvironmentVariable'), 'false')
  assert.equal(field('enableNodeCliInspectArguments'), 'false')
  assert.equal(field('onlyLoadAppFromAsar'), 'true')
  assert.equal(field('enableEmbeddedAsarIntegrityValidation'), 'true')
})

test('a release is signed for the hardened runtime and notarized', () => {
  assert.equal(field('hardenedRuntime'), 'true')
  assert.equal(field('notarize'), 'true')
  assert.equal(field('entitlements'), 'build/entitlements.mac.plist')
})

test('without a Developer ID the release is ad-hoc signed, without the runtime that would refuse it', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>
  }
  for (const name of ['dist:adhoc', 'release:adhoc']) {
    for (const flag of ['-c.mac.identity=-', '-c.mac.hardenedRuntime=false', '-c.mac.notarize=false']) {
      assert.ok(scripts[name]?.includes(flag), `${name} passes ${flag}`)
    }
  }
})
