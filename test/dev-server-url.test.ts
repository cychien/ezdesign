import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { OriginScanner, localOriginsIn, parseListeningPorts, stripAnsi } from '../src/dev-server/urls.js'

const OUTPUT = join(import.meta.dirname, 'fixtures', 'dev-server-output')

function scan(name: string, chunking: 'whole' | 'bytes' | 'thirds'): readonly string[] {
  const text = readFileSync(join(OUTPUT, name), 'utf8')
  const scanner = new OriginScanner()
  const chunks =
    chunking === 'whole'
      ? [text]
      : chunking === 'bytes'
        ? [...text]
        : [text.slice(0, text.length / 3), text.slice(text.length / 3, (2 * text.length) / 3), text.slice((2 * text.length) / 3)]
  for (const chunk of chunks) scanner.push(chunk)
  scanner.flush()
  return scanner.origins
}

const cases: [string, string[]][] = [
  ['vite-6.4-plain.txt', ['http://localhost:4471']],
  ['vite-6.4-color.txt', ['http://localhost:4471']],
  ['astro-7.4-already-running.txt', ['http://localhost:4420']],
  ['astro-7.4-daemonized.txt', ['http://localhost:5496']],
  ['vite-6.4-moved-port.txt', ['http://localhost:5491']],
]

for (const [name, expected] of cases) {
  for (const chunking of ['whole', 'bytes', 'thirds'] as const) {
    test(`finds the origins in ${name} fed ${chunking}`, () => {
      assert.deepEqual(scan(name, chunking), expected)
    })
  }
}

test('reads every local spelling of a host, and skips the network', () => {
  assert.deepEqual(localOriginsIn('- Local:        http://localhost:3000'), ['http://localhost:3000'])
  assert.deepEqual(localOriginsIn('  ➜ Local:    http://0.0.0.0:3000/'), ['http://localhost:3000'])
  assert.deepEqual(localOriginsIn('listening on http://[::1]:4321/ and http://127.0.0.1:4322.'), [
    'http://[::1]:4321',
    'http://127.0.0.1:4322',
  ])
  assert.deepEqual(localOriginsIn('  ➜  Network: http://192.168.1.20:5173/'), [])
  assert.deepEqual(localOriginsIn('Ready at https://localhost:8443/app'), ['https://localhost:8443'])
})

test('a redrawn line keeps what was drawn last', () => {
  const scanner = new OriginScanner()
  assert.deepEqual(scanner.push('building...\rready at http://localhost:7000\n'), ['ready at http://localhost:7000'])
  assert.deepEqual(scanner.origins, ['http://localhost:7000'])
})

test('strips colour and title sequences', () => {
  assert.equal(stripAnsi('\x1b[36mhttp://localhost:\x1b[1m4471\x1b[22m/\x1b[39m'), 'http://localhost:4471/')
  assert.equal(stripAnsi('\x1b]0;vite\x07ready'), 'ready')
})

test('listening ports from lsof, lowest first', () => {
  const out = ['p4242', 'f21', 'n*:5174', 'f22', 'n127.0.0.1:5173', 'p4243', 'f9', 'n[::1]:5173', ''].join('\n')
  assert.deepEqual(parseListeningPorts(out), [5173, 5174])
})
