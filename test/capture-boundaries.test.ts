import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

interface Import {
  from: string
  spec: string
  target: string
  typeOnly: boolean
  dynamic: boolean
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.ts$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : []
  })
}

function importsOf(file: string): Import[] {
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const found: Import[] = []
  const add = (spec: string, typeOnly: boolean, dynamic: boolean) => {
    let target = spec
    if (spec.startsWith('.')) {
      const base = resolve(dirname(file), spec)
      target = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`].find((p) => existsSync(p)) ?? base
    }
    found.push({ from: file, spec, target, typeOnly, dynamic })
  }
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
    add(m[2]!, Boolean(m[1]), false)
  }
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]!, false, true)
  return found
}

const imports = walk(SRC).flatMap(importsOf)
const rel = (path: string) => relative(ROOT, path).split(sep).join('/')
const inside = (path: string, dir: string) => rel(path).startsWith(`${dir}/`)
const show = (list: Import[]) => list.map((i) => `${rel(i.from)} -> ${i.spec}`).join('\n')

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
  const reached = [...seen].filter((f) => inside(f, 'src/library')).map(rel)
  assert.deepEqual(reached, [])
})
