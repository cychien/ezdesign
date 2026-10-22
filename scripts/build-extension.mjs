import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SRC = 'src/extension'

export const extensionFiles = [
  { name: 'worker.js', bundle: `${SRC}/worker/main.ts` },
  { name: 'setup.js', bundle: `${SRC}/setup/main.ts` },
  { name: 'setup.css', bundle: `${SRC}/setup/setup.css` },
  { name: 'setup.html', copy: `${SRC}/pages/setup.html` },
]

/** Chrome's `version` is one to four dot-separated integers; the full string,
 *  prerelease and all, goes to `version_name`. */
export function chromeVersion(version) {
  return version.split(/[-+]/)[0]
}

export function manifestReferences(manifest) {
  return [manifest.background.service_worker, ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources)]
}

export function withGeneration(manifest, generation, version) {
  const at = (name) => `g/${generation}/${name}`
  return {
    ...manifest,
    version: chromeVersion(version),
    version_name: version,
    background: { ...manifest.background, service_worker: at(manifest.background.service_worker) },
    ...(manifest.web_accessible_resources && {
      web_accessible_resources: manifest.web_accessible_resources.map((w) => ({ ...w, resources: w.resources.map(at) })),
    }),
  }
}

export async function buildExtension({ version, browser, outDir = 'dist/extension' }) {
  const files = await Promise.all(
    extensionFiles.map(async (file) => {
      if (file.copy) return { name: file.name, bytes: readFileSync(file.copy) }
      const result = await build({
        ...browser,
        minify: true,
        entryPoints: [file.bundle],
        outfile: file.name,
        write: false,
        define: { __EZDESIGN_VERSION__: JSON.stringify(version) },
      })
      return { name: file.name, bytes: Buffer.from(result.outputFiles[0].contents) }
    }),
  )
  const hash = createHash('sha256')
  for (const file of files) hash.update(file.name).update(file.bytes)
  const generation = `${chromeVersion(version)}-${hash.digest('hex').slice(0, 10)}`
  rmSync(outDir, { recursive: true, force: true })
  for (const file of files) {
    const path = join(outDir, 'g', generation, file.name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.bytes)
  }
  const manifest = JSON.parse(readFileSync(`${SRC}/manifest.json`, 'utf8'))
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(withGeneration(manifest, generation, version), null, 2)}\n`)
  return generation
}
