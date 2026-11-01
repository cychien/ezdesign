import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT, inside, rel, scanImports, show } from './helpers/imports.js'

const SRC = join(ROOT, 'src')
const imports = scanImports('src')

test('the library is entered only through its two public files', () => {
  const crossing = imports.filter(
    (i) =>
      !inside(i.from, 'src/library') &&
      inside(i.target, 'src/library') &&
      !['src/library/index.ts', 'src/library/policy.ts'].includes(rel(i.target)),
  )
  assert.deepEqual(crossing, [], `library internals imported from outside:\n${show(crossing)}`)
})

test('node:sqlite is loaded lazily, by the store alone', () => {
  const sqlite = imports.filter((i) => i.spec === 'node:sqlite')
  const misplaced = sqlite.filter((i) => rel(i.from) !== 'src/library/internal/store.ts')
  assert.deepEqual(misplaced, [], `node:sqlite outside the store:\n${show(misplaced)}`)
  const eager = sqlite.filter((i) => !i.typeOnly && !i.dynamic)
  assert.deepEqual(eager, [], `a static node:sqlite import fails every command on a node without it:\n${show(eager)}`)
  assert.ok(sqlite.some((i) => i.dynamic), 'the store loads node:sqlite')
})

test("the library's policy file imports nothing, so the extension can bundle it", () => {
  const own = imports.filter((i) => rel(i.from) === 'src/library/policy.ts')
  assert.deepEqual(own, [], show(own))
})

test('the published vite entry cannot reach the library', () => {
  const graph = new Map<string, string[]>()
  for (const i of imports) {
    if (!i.dynamic && !i.typeOnly && i.target.endsWith('.ts')) {
      graph.set(i.from, [...(graph.get(i.from) ?? []), i.target])
    }
  }
  const seen = new Set<string>()
  const stack = [join(SRC, 'vite.ts')]
  while (stack.length) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    stack.push(...(graph.get(file) ?? []))
  }
  assert.ok(seen.size > 1, 'the walk followed the entry')
  const reached = [...seen].filter((f) => inside(f, 'src/library') || inside(f, 'src/native-host')).map(rel)
  assert.deepEqual(reached, [])
})

test('the wire imports only zod, and the wire and the library never see each other', () => {
  const wire = imports.filter((i) => rel(i.from) === 'src/capture-wire.ts' && i.spec !== 'zod')
  assert.deepEqual(wire, [], show(wire))
  const leak = imports.filter(
    (i) =>
      (inside(i.from, 'src/library') && rel(i.target) === 'src/capture-wire.ts') ||
      (rel(i.from) === 'src/capture-wire.ts' && inside(i.target, 'src/library')),
  )
  assert.deepEqual(leak, [], `wire and library types meet only in src/native-host/session.ts:\n${show(leak)}`)
})

test('the extension bundles only browser-safe sources', () => {
  const allowed = new Set([
    'src/capture-wire.ts',
    'src/library/policy.ts',
    'src/client/region.ts',
    'src/client/thumbnail.ts',
  ])
  const bad = imports.filter(
    (i) =>
      inside(i.from, 'src/extension') &&
      (i.spec.startsWith('.') ? !inside(i.target, 'src/extension') && !allowed.has(rel(i.target)) : i.spec !== 'zod'),
  )
  assert.deepEqual(bad, [], `the extension imports something that is not its own or browser-safe:\n${show(bad)}`)
})

test('nothing in src reaches into the extension, the host, or the installer internals', () => {
  const owned: [string, (target: string) => boolean][] = [
    ['src/extension', (t) => inside(t, 'src/extension')],
    ['src/native-host', (t) => inside(t, 'src/native-host')],
    ['src/capture-install', (t) => inside(t, 'src/capture-install') && rel(t) !== 'src/capture-install/index.ts'],
  ]
  const bad = imports.filter((i) => owned.some(([dir, isInternal]) => !inside(i.from, dir) && isInternal(i.target)))
  assert.deepEqual(bad, [], show(bad))
  const host = imports.filter((i) => rel(i.target) === 'src/native-host/main.ts')
  assert.deepEqual(host, [], `the host entry is run, never imported:\n${show(host)}`)
})
