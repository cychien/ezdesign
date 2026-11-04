import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const json = <T>(path: string) => JSON.parse(read(path)) as T

interface ReleasePackage {
  component?: string
  'include-component-in-tag'?: boolean
  draft?: boolean
  'force-tag-creation'?: boolean
  'extra-files'?: string[]
}

const config = json<{ packages: Record<string, ReleasePackage> }>('release-please-config.json')
const manifest = json<Record<string, string>>('.release-please-manifest.json')
const workflow = read('.github/workflows/release.yml')

/** Each job's block of the workflow, by name. */
const jobs = new Map(
  [...workflow.split(/^jobs:\n/m)[1]!.matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/gm)].map((m) => [m[1]!, m[2]!]),
)

/** The version the canary job publishes from `version`: `npm version prepatch --preid canary.<run>`. */
const canaryOf = (version: string) => {
  const [major, minor, patch] = version.split('.').map(Number)
  return new RegExp(`^${major}\\.${minor}\\.${patch! + 1}-canary\\.\\d+\\.0$`)
}

// The canary job bumps package.json before `prepublishOnly` runs this, so its
// prepatch of the manifest's version is the one other version allowed here.
test('release-please counts from the versions the packages are at', () => {
  const pkg = json<{ version: string }>('package.json')
  const desktop = json<{ version: string }>('desktop/package.json')
  assert.ok(
    pkg.version === manifest['.'] || canaryOf(manifest['.']!).test(pkg.version),
    `package.json ${pkg.version} is neither the manifest's ${manifest['.']} nor its canary`,
  )
  assert.equal(manifest.desktop, desktop.version)
  assert.deepEqual(Object.keys(config.packages).sort(), Object.keys(manifest).sort())
})

test("the npm package keeps v-tags and the app keeps electron-builder's desktop-v tags", () => {
  assert.equal(config.packages['.']!['include-component-in-tag'], false)
  const prefix = /^\s*tagNamePrefix:\s*(.+)$/m.exec(read('desktop/electron-builder.yml'))?.[1]?.trim()
  assert.equal(`${config.packages.desktop!.component}-v`, prefix)
})

// GitHub makes a new published release Latest, and the site's download links and
// the app's update check read the Latest release. So every release-please release
// starts as a draft, and the workflow publishes the npm one without Latest.
test('no release reaches Latest before its files are in, and npm releases never do', () => {
  for (const [path, pkg] of Object.entries(config.packages)) {
    assert.equal(pkg.draft, true, `${path} starts as a draft`)
    assert.equal(pkg['force-tag-creation'], true, `${path} is tagged while a draft, so the next release finds it`)
  }
  assert.match(jobs.get('stable')!, /gh release edit "v\$VERSION" --draft=false --latest=false/)
  assert.match(jobs.get('desktop')!, /gh release edit "\$TAG" --draft=false --latest/)
})

test('a release bumps the bundled skill version with the package', () => {
  assert.deepEqual(config.packages['.']!['extra-files'], ['skills/ezdesign/SKILL.md'])
})

test('a canary goes out when anything the tarball is built from changed', () => {
  const paths = /git diff --quiet "\$BEFORE" HEAD -- (.+);/.exec(jobs.get('pending')!)?.[1]?.split(' ') ?? []
  const { files } = json<{ files: string[] }>('package.json')
  const builtFrom: Record<string, string[]> = { dist: ['src', 'scripts/build.mjs'] }
  for (const entry of files) {
    for (const source of builtFrom[entry] ?? [entry]) assert.ok(paths.includes(source), `${source} (for ${entry})`)
  }
  for (const source of ['package.json', 'pnpm-lock.yaml']) assert.ok(paths.includes(source), source)
})

test('only the publishing jobs can ask for an OIDC token, and none of them restores a cache', () => {
  assert.match(workflow, /^permissions: \{\}$/m)
  for (const [name, body] of jobs) {
    assert.equal(/id-token: write/.test(body), name === 'stable' || name === 'canary', `${name} id-token`)
    if (!/actions\/setup-node/.test(body)) continue
    assert.match(body, /package-manager-cache: false/, `${name} restores no cache`)
    assert.doesNotMatch(body, /^\s+cache:/m, `${name} restores no cache`)
  }
  for (const name of ['stable', 'canary', 'desktop']) {
    assert.match(jobs.get(name)!, /environment: release/, `${name} runs in the release environment`)
  }
})
