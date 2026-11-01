import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface Import {
  from: string
  spec: string
  target: string
  typeOnly: boolean
  dynamic: boolean
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path)
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

export const sources = (...dirs: string[]): string[] => dirs.flatMap((dir) => walk(join(ROOT, dir)))

export const scanImports = (...dirs: string[]): Import[] => sources(...dirs).flatMap(importsOf)
export const rel = (path: string): string => relative(ROOT, path).split(sep).join('/')
export const inside = (path: string, dir: string): boolean => rel(path).startsWith(`${dir}/`)
export const show = (list: Import[]): string => list.map((i) => `${rel(i.from)} -> ${i.spec}`).join('\n')
