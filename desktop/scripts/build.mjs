// A sandboxed preload cannot be an ES module.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('../package.json', 'utf8'))

await Promise.all([
  build({
    entryPoints: ['src/main.ts'],
    outfile: 'dist/main.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    bundle: true,
    external: ['electron'],
    // electron-updater is CommonJS and calls require() at runtime.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    define: { __EZDESIGN_PACKAGE_VERSION__: JSON.stringify(version) },
  }),
  build({
    entryPoints: ['src/preload.ts'],
    outfile: 'dist/preload.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    bundle: true,
    external: ['electron'],
  }),
])
