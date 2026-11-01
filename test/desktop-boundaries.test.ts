import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { inside, rel, scanImports, show, sources } from './helpers/imports.js'

const imports = scanImports('src', 'desktop/src')
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

test('the dev server and the project list are entered through their public files', () => {
  const doors: Record<string, string[]> = {
    'src/dev-server': ['src/dev-server/index.ts', 'src/dev-server/wire.ts'],
    'src/projects': ['src/projects/hub.ts', 'src/projects/book.ts', 'src/projects/routes.ts', 'src/projects/wire.ts'],
  }
  const crossing = imports.filter((i) =>
    Object.entries(doors).some(([dir, open]) => !inside(i.from, dir) && inside(i.target, dir) && !open.includes(rel(i.target))),
  )
  assert.deepEqual(crossing, [], `internals imported from outside:\n${show(crossing)}`)
})

test('the pages see the daemon only through wire modules', () => {
  const allowed = new Set(['src/dev-server/wire.ts', 'src/projects/wire.ts', 'src/desktop-wire.ts', 'src/version-header.ts'])
  const touched = ['src/dev-server', 'src/projects']
  const bad = imports.filter(
    (i) =>
      inside(i.from, 'src/client') &&
      (touched.some((dir) => inside(i.target, dir)) || ['src/desktop-host.ts', 'src/self-node.ts'].includes(rel(i.target))) &&
      !allowed.has(rel(i.target)),
  )
  assert.deepEqual(bad, [], show(bad))
})

test('the wire modules a page bundles import nothing at runtime', () => {
  const wires = ['src/dev-server/wire.ts', 'src/projects/wire.ts', 'src/desktop-wire.ts', 'src/version-header.ts']
  const bad = imports.filter((i) => wires.includes(rel(i.from)) && !i.typeOnly)
  assert.deepEqual(bad, [], show(bad))
})

test('the app takes from the npm package only its host module and the wire', () => {
  const allowed = new Set(['src/desktop-host.ts', 'src/desktop-wire.ts', 'src/self-node.ts', 'src/projects/wire.ts'])
  const bad = imports.filter(
    (i) => inside(i.from, 'desktop/src') && i.spec.startsWith('.') && !inside(i.target, 'desktop/src') && !allowed.has(rel(i.target)),
  )
  assert.deepEqual(bad, [], show(bad))
})

test("only self-node names Electron's run-as-node flag", () => {
  const naming = sources('src', 'desktop/src')
    .filter((file) => rel(file) !== 'src/self-node.ts')
    .filter((file) => withoutComments(readFileSync(file, 'utf8')).includes('ELECTRON_RUN_AS_NODE'))
    .map(rel)
  assert.deepEqual(naming, [], 'set and cleared in one place, so no child inherits it by accident')
})
