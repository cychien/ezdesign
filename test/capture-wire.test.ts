import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ALLOWED_ORIGINS,
  EXTENSION_ID,
  HOST_CHUNK_BYTES,
  HOST_MESSAGE_MAX_BYTES,
  type HostMessage,
  PROTOCOL,
  ReplyValue,
  negotiateProtocol,
  parseHostMessage,
  parseRequest,
} from '../src/capture-wire.js'
import { buildExtension, extensionFiles, manifestReferences } from '../scripts/build-extension.mjs'

const manifest = JSON.parse(readFileSync(new URL('../src/extension/manifest.json', import.meta.url), 'utf8')) as {
  key: string
}

test('CX-p2-identity: the pinned extension id is the one the manifest key produces', () => {
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  const id = [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('')
  assert.equal(id, EXTENSION_ID)
  assert.deepEqual(ALLOWED_ORIGINS, ['chrome-extension://bgcgoejgebannhlbgfinbghahicahapb/'])
})

test('CX-p2-identity: the built extension keeps the key and carries every file its manifest names', async () => {
  const outDir = join(mkdtempSync(join(tmpdir(), 'ezdesign-extension-')), 'extension')
  const generation = await buildExtension({
    version: '1.2.3-beta.1',
    browser: { platform: 'browser', format: 'iife', target: 'es2020', bundle: true },
    outDir,
  })
  assert.match(generation, /^1\.2\.3-[0-9a-f]{10}$/)
  const built = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  assert.equal(built.key, manifest.key)
  assert.deepEqual([built.version, built.version_name], ['1.2.3', '1.2.3-beta.1'])
  const named = manifestReferences(built)
  assert.deepEqual(
    named,
    ['worker.js', 'dialog.html', 'dialog.js', 'dialog.css', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png'].map(
      (f) => `g/${generation}/${f}`,
    ),
  )
  for (const name of [...named, ...extensionFiles.map((f) => `g/${generation}/${f.name}`)]) {
    assert.ok(existsSync(join(outDir, name)), `${name} is built`)
  }
})

test('every file the manifest names is a file the extension build produces', () => {
  const built = new Set(extensionFiles.map((f) => f.name))
  const missing = manifestReferences(manifest).filter((name) => !built.has(name))
  assert.deepEqual(missing, [])
})

test('the protocol both sides speak is the highest in both ranges, or none', () => {
  assert.equal(negotiateProtocol({ min: 1, max: 3 }, { min: 1, max: 2 }), 2)
  assert.equal(negotiateProtocol({ min: 2, max: 3 }, { min: 1, max: 2 }), 2)
  assert.equal(negotiateProtocol({ min: 3, max: 4 }, { min: 1, max: 2 }), null)
  assert.equal(negotiateProtocol(PROTOCOL, PROTOCOL), PROTOCOL.max)
})

test('the largest bytes frame the host can write fits under the 1 MiB cap', () => {
  const frame: HostMessage = {
    t: 'bytes',
    re: Number.MAX_SAFE_INTEGER,
    seq: Number.MAX_SAFE_INTEGER,
    data: Buffer.alloc(HOST_CHUNK_BYTES, 0xff).toString('base64'),
  }
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) < HOST_MESSAGE_MAX_BYTES)
})

test('requests are validated at the host boundary', () => {
  assert.equal(parseRequest({ t: 'hello', id: 1, protocol: PROTOCOL, extension: { version: '0.9.0' } }).ok, true)
  const fileUrl = parseRequest({
    t: 'download',
    id: 2,
    capture: 'cap_0123456789',
    kind: 'image',
    url: 'file:///etc/passwd',
    referer: null,
    userAgent: 'x',
    context: { pageUrl: 'https://a.test/', pageTitle: 'a', mediaUrl: null, capturedAt: 1 },
  })
  assert.equal(fileUrl.ok, false)
  const unknown = parseRequest({ t: 'format-disk', id: 3 })
  assert.ok(!unknown.ok && unknown.error.code === 'bad-request')
})

test('a newer peer may add fields without breaking an older parser', () => {
  const parsed = parseHostMessage({ t: 'result', re: 1, value: {}, traceId: 'from-the-future' })
  assert.deepEqual(parsed, { t: 'result', re: 1, value: {} })
  assert.equal(parseHostMessage({ t: 'telemetry' }), null)
  assert.equal(
    ReplyValue.download.safeParse({ outcome: 'file', bytes: 5, mediaType: 'image/png', duplicate: null, x: 1 })
      .success,
    true,
  )
})
