import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { HOST_NAME } from '../src/capture-wire.js'
import {
  type InstallOptions,
  captureStatus,
  installCapture,
  readInstallRecord,
  refreshCaptureInstall,
  uninstallCapture,
} from '../src/capture-install/index.js'
import { openLibrary } from '../src/library/index.js'

const node = { path: process.execPath, version: process.version }
const MAC = 'Library/Application Support'

function distFor(root: string, version: string): string {
  const generation = `${version}-${createHash('sha1').update(version).digest('hex').slice(0, 10)}`
  const distDir = join(root, `dist-${version}`)
  mkdirSync(join(distDir, 'extension', 'g', generation), { recursive: true })
  writeFileSync(join(distDir, 'native-host.mjs'), `// host ${version}\n`)
  writeFileSync(join(distDir, 'extension', 'g', generation, 'worker.js'), `// worker ${version}\n`)
  writeFileSync(
    join(distDir, 'extension', 'manifest.json'),
    JSON.stringify({ version, background: { service_worker: `g/${generation}/worker.js` } }),
  )
  return distDir
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'ezdesign-capture-install-'))
  const home = join(root, 'home')
  const browsers = {
    chrome: join(home, MAC, 'Google/Chrome'),
    arc: join(home, MAC, 'Arc/User Data'),
    brave: join(home, MAC, 'BraveSoftware/Brave-Browser'),
  }
  for (const dir of Object.values(browsers)) mkdirSync(dir, { recursive: true })
  const options: InstallOptions = {
    distDir: distFor(root, '0.9.0'),
    version: '0.9.0',
    dataDir: join(root, 'data'),
    home,
    platform: 'darwin',
    node,
  }
  return { root, home, browsers, options }
}

const manifestIn = (userDataDir: string) => join(userDataDir, 'NativeMessagingHosts', `${HOST_NAME}.json`)

function listing(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    if (!existsSync(at)) return
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return out
}

test('install writes the host, the wrapper and a manifest for every browser found', async () => {
  const w = world()
  const report = await installCapture(w.options)
  const dataDir = w.options.dataDir!
  assert.deepEqual(report.targets.map((t) => t.browser?.name), ['Google Chrome', 'Arc', 'Brave'])
  for (const dir of Object.values(w.browsers)) {
    assert.deepEqual(JSON.parse(readFileSync(manifestIn(dir), 'utf8')), {
      name: HOST_NAME,
      description: 'ezdesign capture: saves to the design library',
      path: join(dataDir, 'native-host', 'ezdesign-native-host'),
      type: 'stdio',
      allowed_origins: ['chrome-extension://bgcgoejgebannhlbgfinbghahicahapb/'],
    })
  }
  const wrapper = readFileSync(report.wrapper, 'utf8')
  assert.equal(
    wrapper,
    `#!/bin/sh\nEZDESIGN_DATA_DIR='${dataDir}' exec '${process.execPath}' '${join(dataDir, 'native-host', 'host.mjs')}' "$@"\n`,
  )
  assert.equal(statSync(report.wrapper).mode & 0o777, 0o755)
  assert.equal(readFileSync(join(dataDir, 'native-host', 'host.mjs'), 'utf8'), '// host 0.9.0\n')
  assert.equal(report.extensionDir, join(dataDir, 'extension'))
  assert.ok(existsSync(join(report.extensionDir, 'manifest.json')))
  assert.equal(readInstallRecord(dataDir)?.manifests.length, 3)
})

test('an install into an explicit user data dir touches no other browser', async () => {
  const w = world()
  const profile = join(w.root, 'cft-profile')
  const report = await installCapture({ ...w.options, userDataDirs: [profile] })
  assert.deepEqual(report.targets.map((t) => t.manifestPath), [manifestIn(profile)])
  assert.ok(existsSync(manifestIn(profile)))
  for (const dir of Object.values(w.browsers)) assert.equal(existsSync(manifestIn(dir)), false)
})

test('install refuses a node below the floor before writing anything', async () => {
  const w = world()
  await assert.rejects(
    installCapture({ ...w.options, node: { path: '/n/20/bin/node', version: 'v20.18.0' } }),
    /needs Node >= 22\.13\.0; this is v20\.18\.0/,
  )
  assert.equal(existsSync(w.options.dataDir!), false)
})

test('CX-uninstall: every manifest install wrote and the host go; a foreign manifest and the library stay', async () => {
  const w = world()
  await installCapture(w.options)
  const dataDir = w.options.dataDir!
  const library = await openLibrary({ dir: join(dataDir, 'library') })
  const stage = library.stage({ kind: 'image', source: { pageUrl: 'p', pageTitle: 't', mediaUrl: null, capturedAt: 1 } })
  await stage.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
  await (await stage.finish()).commit({ tags: ['kept'], note: '' })
  library.close()
  const edge = join(w.home, MAC, 'Microsoft Edge')
  mkdirSync(join(edge, 'NativeMessagingHosts'), { recursive: true })
  const foreign = JSON.stringify({ name: HOST_NAME, path: '/elsewhere/data/native-host/ezdesign-native-host' })
  writeFileSync(manifestIn(edge), foreign)
  const libraryBefore = listing(join(dataDir, 'library'))

  const report = await uninstallCapture({ dataDir, home: w.home, platform: 'darwin' })
  assert.deepEqual(report.removedManifests.sort(), Object.values(w.browsers).map(manifestIn).sort())
  assert.deepEqual(report.keptManifests, [manifestIn(edge)])
  for (const dir of Object.values(w.browsers)) assert.equal(existsSync(manifestIn(dir)), false)
  assert.equal(readFileSync(manifestIn(edge), 'utf8'), foreign)
  assert.equal(existsSync(join(dataDir, 'native-host')), false)
  assert.equal(existsSync(join(dataDir, 'extension')), false)
  assert.deepEqual(listing(join(dataDir, 'library')), libraryBefore)

  const everything = listing(w.root)
  const again = await uninstallCapture({ dataDir, home: w.home, platform: 'darwin' })
  assert.deepEqual(again, { removedManifests: [], keptManifests: [manifestIn(edge)] })
  assert.deepEqual(listing(w.root), everything, 'a second uninstall changes nothing')
})

test('CX-p2-refresh: daemon start moves an install up to the running version, and never back', async () => {
  const w = world()
  const dataDir = w.options.dataDir!
  const profile = join(w.root, 'only-this-profile')
  await installCapture({ ...w.options, userDataDirs: [profile] })
  const next = distFor(w.root, '0.9.1')
  const at = { dataDir, home: w.home, platform: 'darwin' as const, node }

  assert.equal(await refreshCaptureInstall({ ...at, distDir: next, version: '0.9.1' }), 'refreshed')
  assert.equal(readFileSync(join(dataDir, 'native-host', 'host.mjs'), 'utf8'), '// host 0.9.1\n')
  assert.match(readFileSync(join(dataDir, 'extension', 'manifest.json'), 'utf8'), /"version":"0\.9\.1"/)
  assert.deepEqual(readdirSync(join(dataDir, 'extension', 'g')).sort(), [
    `0.9.0-${createHash('sha1').update('0.9.0').digest('hex').slice(0, 10)}`,
    `0.9.1-${createHash('sha1').update('0.9.1').digest('hex').slice(0, 10)}`,
  ])
  assert.deepEqual(readInstallRecord(dataDir)?.manifests, [manifestIn(profile)], 'the browser set is kept')
  for (const dir of Object.values(w.browsers)) assert.equal(existsSync(manifestIn(dir)), false)

  assert.equal(await refreshCaptureInstall({ ...at, distDir: next, version: '0.9.1' }), 'current')
  const before = listing(w.root)
  assert.equal(await refreshCaptureInstall({ ...at, distDir: w.options.distDir, version: '0.9.0' }), 'newer-installed')
  assert.deepEqual(listing(w.root), before, 'an older version changes no file')

  const empty = world()
  assert.equal(await refreshCaptureInstall({ ...empty.options, version: '0.9.1' }), 'not-installed')
  assert.equal(existsSync(empty.options.dataDir!), false)
})

test('a refresh repairs files that went missing at the same version', async () => {
  const w = world()
  await installCapture(w.options)
  const host = join(w.options.dataDir!, 'native-host', 'host.mjs')
  writeFileSync(host, '')
  assert.equal(await refreshCaptureInstall(w.options), 'current')
  rmSync(host)
  assert.equal(await refreshCaptureInstall(w.options), 'refreshed')
  assert.equal(readFileSync(host, 'utf8'), '// host 0.9.0\n')
})

test('a refresh installs a rebuilt extension of the same version', async () => {
  const w = world()
  await installCapture(w.options)
  const rebuilt = join(w.root, 'dist-rebuilt')
  const generation = '0.9.0-rebuilt000'
  mkdirSync(join(rebuilt, 'extension', 'g', generation), { recursive: true })
  writeFileSync(join(rebuilt, 'native-host.mjs'), '// host 0.9.0\n')
  writeFileSync(join(rebuilt, 'extension', 'g', generation, 'icon-16.png'), 'png')
  writeFileSync(join(rebuilt, 'extension', 'g', generation, 'worker.js'), '// worker 0.9.0\n')
  writeFileSync(
    join(rebuilt, 'extension', 'manifest.json'),
    JSON.stringify({ version: '0.9.0', background: { service_worker: `g/${generation}/worker.js` } }),
  )
  assert.equal(await refreshCaptureInstall({ ...w.options, distDir: rebuilt }), 'refreshed')
  assert.equal(readInstallRecord(w.options.dataDir)?.extensionGeneration, generation)
  assert.ok(existsSync(join(w.options.dataDir!, 'extension', 'g', generation, 'icon-16.png')))
  assert.equal(await refreshCaptureInstall({ ...w.options, distDir: rebuilt }), 'current')
})

test('a corrupt install record is surfaced, not taken for no install', async () => {
  const w = world()
  await installCapture(w.options)
  writeFileSync(join(w.options.dataDir!, 'native-host', 'install.json'), '{')
  await assert.rejects(refreshCaptureInstall(w.options), /is not a capture install record/)
  const status = await captureStatus(w.options)
  assert.deepEqual(status.problems.map((p) => p.type), ['record-unreadable'])
})

test('status reports what is wrong and creates nothing', async () => {
  const fresh = world()
  const none = await captureStatus(fresh.options)
  assert.deepEqual(none.problems, [{ type: 'not-installed' }])
  assert.equal(existsSync(fresh.options.dataDir!), false)

  const w = world()
  await installCapture(w.options)
  assert.deepEqual((await captureStatus(w.options)).problems, [])
  rmSync(manifestIn(w.browsers.arc))
  const status = await captureStatus({ ...w.options, version: '0.9.1' })
  assert.deepEqual(status.problems, [
    { type: 'stale', installed: '0.9.0', running: '0.9.1' },
    { type: 'manifest-missing', manifestPath: manifestIn(w.browsers.arc) },
  ])
  assert.deepEqual(
    status.targets.map((t) => [t.target.browser?.name, t.installed]),
    [
      ['Google Chrome', true],
      ['Arc', false],
      ['Brave', true],
    ],
  )
})
