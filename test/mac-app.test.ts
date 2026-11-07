import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  checkBundle,
  downloadVerified,
  parseFeedManifest,
  unpackApp,
  zipFor,
} from '../src/mac-app-bundle.js'
import { MacAppInstaller, type MacAppPlacement } from '../src/mac-app.js'
import type { MacAppJobWire } from '../src/mac-app-wire.js'
import { fakeApp, macOnly, zipApp } from './helpers/mac-app.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'ezdesign-mac-app-'))
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64')

async function serve(files: Record<string, Buffer | string>): Promise<{ url: string; hits: string[]; server: Server }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url!.slice(1))
    hits.push(name)
    const body = files[name]
    if (body === undefined) return void res.writeHead(404).end()
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server }
}

function feedYaml(version: string, files: { url: string; bytes: Buffer }[]): string {
  return [
    `version: ${version}`,
    'files:',
    ...files.flatMap((f) => [`  - url: ${f.url}`, `    sha512: ${sha512(f.bytes)}`, `    size: ${f.bytes.length}`]),
    `path: ${files[0]!.url}`,
    `sha512: ${sha512(files[0]!.bytes)}`,
    "releaseDate: '2026-11-01T17:34:28.896Z'",
    '',
  ].join('\n')
}

test('the release feed is read for its version and every file, and the zip for this Mac is picked by its architecture', () => {
  const feed = parseFeedManifest(`version: 0.1.1
files:
  - url: ezdesign-0.1.1-mac.zip
    sha512: aaa+/=
    size: 136272872
  - url: ezdesign-0.1.1-arm64-mac.zip
    sha512: bbb==
    size: 130354426
  - url: ezdesign-arm64.dmg
    sha512: ccc==
    size: 132252342
path: ezdesign-0.1.1-mac.zip
sha512: aaa+/=
releaseDate: '2026-11-01T17:34:28.896Z'
`)
  assert.equal(feed.version, '0.1.1')
  assert.deepEqual(feed.files.map((f) => [f.url, f.sha512, f.size]), [
    ['ezdesign-0.1.1-mac.zip', 'aaa+/=', 136272872],
    ['ezdesign-0.1.1-arm64-mac.zip', 'bbb==', 130354426],
    ['ezdesign-arm64.dmg', 'ccc==', 132252342],
  ])
  assert.equal(zipFor(feed.files, 'arm64')?.sha512, 'bbb==')
  assert.equal(zipFor(feed.files, 'x64')?.sha512, 'aaa+/=')
  assert.equal(zipFor([{ url: 'ezdesign-arm64.dmg', sha512: 'c' }], 'arm64'), null)
  assert.throws(() => parseFeedManifest('<html>not found</html>'), /no version or no files/)
})

test('a download that is not the release’s is refused and not kept, and its progress is told as it comes', async () => {
  const bytes = Buffer.alloc(256 * 1024, 7)
  const { url, server } = await serve({ 'update.zip': bytes })
  try {
    const dir = tmp()
    const seen: number[] = []
    await downloadVerified(`${url}/update.zip`, sha512(bytes), join(dir, 'good.zip'), { onProgress: (n) => seen.push(n) })
    assert.deepEqual(readFileSync(join(dir, 'good.zip')), bytes)
    assert.equal(seen.at(-1), bytes.length)
    await assert.rejects(downloadVerified(`${url}/update.zip`, sha512(Buffer.from('else')), join(dir, 'bad.zip')), /does not match/)
    assert.equal(existsSync(join(dir, 'bad.zip')), false)
  } finally {
    server.close()
  }
})

test('the unpacked app must be this app, at the version offered, with its signature whole', macOnly, async () => {
  const dir = tmp()
  const zip = zipApp(fakeApp(join(dir, 'build'), '0.1.1'), join(dir, 'update.zip'))
  const unpacked = await unpackApp(zip, join(dir, 'unpacked'))
  assert.ok(unpacked.endsWith('/ezdesign.app'))
  await checkBundle(unpacked, { id: 'dev.ezdesign.app', version: '0.1.1' })
  await assert.rejects(checkBundle(unpacked, { id: 'dev.ezdesign.app', version: '0.1.2' }), /another version/)
  await assert.rejects(checkBundle(unpacked, { id: 'dev.other.app', version: '0.1.1' }), /another app/)
  writeFileSync(join(unpacked, 'Contents', 'MacOS', 'ezdesign'), '#!/bin/sh\necho tampered\n')
  await assert.rejects(checkBundle(unpacked, { id: 'dev.ezdesign.app', version: '0.1.1' }))
})

function installer(dirs: string[], feed: string, overrides: Partial<MacAppPlacement> = {}) {
  const opened: string[] = []
  const placement: MacAppPlacement = {
    platform: 'darwin',
    dirs,
    feed,
    arch: async () => 'arm64',
    open: async (app) => void opened.push(app),
    ...overrides,
  }
  return { mac: new MacAppInstaller(placement), opened }
}

test('installing downloads this Mac’s build, puts it in Applications and opens it', macOnly, async () => {
  const dir = tmp()
  const arm = readFileSync(zipApp(fakeApp(join(dir, 'arm'), '0.2.0'), join(dir, 'arm.zip')))
  const intel = Buffer.from('not for this Mac')
  const { url, hits, server } = await serve({
    'latest-mac.yml': feedYaml('0.2.0', [
      { url: 'ezdesign-0.2.0-mac.zip', bytes: intel },
      { url: 'ezdesign-0.2.0-arm64-mac.zip', bytes: arm },
    ]),
    'ezdesign-0.2.0-arm64-mac.zip': arm,
    'ezdesign-0.2.0-mac.zip': intel,
  })
  try {
    const applications = join(dir, 'Applications')
    const { mac, opened } = installer([applications], url)
    assert.deepEqual(await mac.status(), {
      supported: true,
      installed: null,
      job: { phase: 'idle' },
      releasesUrl: 'https://github.com/cychien/ezdesign/releases/latest',
    })

    mac.start()
    const phases: MacAppJobWire['phase'][] = [(await mac.status()).job.phase]
    mac.start()
    await mac.settled()
    phases.push((await mac.status()).job.phase)
    assert.deepEqual(phases, ['downloading', 'idle'])

    const app = join(applications, 'ezdesign.app')
    assert.deepEqual((await mac.status()).installed, { path: app, version: '0.2.0' })
    assert.deepEqual(opened, [app])
    assert.deepEqual(readdirSync(applications), ['ezdesign.app'], 'no staging folder is left behind')
    assert.deepEqual(hits, ['latest-mac.yml', 'ezdesign-0.2.0-arm64-mac.zip'], 'one install for two clicks')

    mac.start()
    await mac.settled()
    assert.deepEqual(opened, [app, app], 'installed already, it is only opened')
    assert.equal(hits.length, 2)

    const unopenable = installer([applications], url, {
      open: async () => {
        throw new Error('LaunchServices said no')
      },
    }).mac
    unopenable.start()
    await unopenable.settled()
    assert.deepEqual((await unopenable.status()).job, { phase: 'idle' }, 'installed is what was asked for, opened or not')
  } finally {
    server.close()
  }
})

test('an install that fails says why and leaves nothing in Applications', macOnly, async () => {
  const dir = tmp()
  const real = readFileSync(zipApp(fakeApp(join(dir, 'arm'), '0.2.0'), join(dir, 'arm.zip')))
  const { url, server } = await serve({
    'latest-mac.yml': feedYaml('0.2.0', [{ url: 'ezdesign-0.2.0-arm64-mac.zip', bytes: real }]),
    'ezdesign-0.2.0-arm64-mac.zip': Buffer.from('tampered'),
  })
  try {
    const applications = join(dir, 'Applications')
    const { mac, opened } = installer([applications], url)
    mac.start()
    await mac.settled()
    assert.deepEqual((await mac.status()).job, { phase: 'failed', error: 'the download does not match the release' })
    assert.deepEqual(readdirSync(applications), [])
    assert.deepEqual(opened, [])

    const intelOnly = installer([applications], url, { arch: async () => 'x64' }).mac
    intelOnly.start()
    await intelOnly.settled()
    assert.deepEqual((await intelOnly.status()).job, { phase: 'failed', error: 'the release has no build for this Mac' })
  } finally {
    server.close()
  }
})

test('a copy already in a later folder is found, and another app by that name is not taken for it', macOnly, async () => {
  const dir = tmp()
  const system = join(dir, 'Applications')
  const user = join(dir, 'home', 'Applications')
  mkdirSync(system, { recursive: true })
  fakeApp(system, '9.9.9', 'com.someone.else')
  fakeApp(user, '0.1.1')
  const { mac, opened } = installer([system, user], 'http://127.0.0.1:9')
  assert.deepEqual((await mac.status()).installed, { path: join(user, 'ezdesign.app'), version: '0.1.1' })
  assert.equal(await mac.open(), true)
  assert.deepEqual(opened, [join(user, 'ezdesign.app')])
})

test('anywhere but macOS there is no app to offer', async () => {
  const { mac } = installer([tmp()], 'http://127.0.0.1:9', { platform: 'linux' })
  mac.start()
  const status = await mac.status()
  assert.equal(status.supported, false)
  assert.equal(status.installed, null)
  assert.deepEqual(status.job, { phase: 'idle' })
  assert.equal(await mac.open(), false)
})
