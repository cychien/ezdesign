import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../fs-atomic.js'

export function installExtension(from: string, to: string): string {
  const manifest = readFileSync(join(from, 'manifest.json'))
  const generation = generationOf(JSON.parse(manifest.toString('utf8')))
  const generations = join(to, 'g')
  mkdirSync(generations, { recursive: true })
  const target = join(generations, generation)
  if (!existsSync(target)) {
    const temp = `${target}.tmp-${process.pid}`
    rmSync(temp, { recursive: true, force: true })
    cpSync(join(from, 'g', generation), temp, { recursive: true })
    renameSync(temp, target)
  }
  const previous = currentGeneration(to)
  writeAtomic(join(to, 'manifest.json'), manifest)
  for (const name of readdirSync(generations)) {
    if (name !== generation && name !== previous) rmSync(join(generations, name), { recursive: true, force: true })
  }
  return generation
}

export function currentGeneration(dir: string): string | null {
  try {
    return generationOf(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
  } catch {
    return null
  }
}

export function generationOf(manifest: unknown): string {
  const worker = (manifest as { background?: { service_worker?: unknown } } | null)?.background?.service_worker
  const match = typeof worker === 'string' ? /^g\/([^/]+)\/[^/]+$/.exec(worker) : null
  if (!match) throw new Error(`the extension manifest names no generation (service_worker ${JSON.stringify(worker)})`)
  return match[1]!
}
