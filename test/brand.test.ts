import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  DESKTOP_ICON,
  EXTENSION_ICONS,
  README_LOCKUPS,
  SOURCE_KEY,
  desktopIconSourceHash,
  iconSourceHash,
  lockupSource,
  readPngSize,
  readPngText,
} from '../scripts/brand-assets.mjs'
import { WORDMARK_MODULE, wordmarkModule } from '../scripts/brand-wordmark.mjs'

const REGENERATE = 'stale: run `npm run brand`'

test('the wordmark outline is what the font in WORDMARK draws today', () => {
  assert.equal(readFileSync(WORDMARK_MODULE, 'utf8'), wordmarkModule(), `${WORDMARK_MODULE} is ${REGENERATE}`)
})

test('the README lockups are what brand.ts draws today', () => {
  for (const lockup of README_LOCKUPS) {
    assert.equal(readFileSync(lockup.path, 'utf8'), lockupSource(lockup), `${lockup.path} is ${REGENERATE}`)
  }
})

test('the extension icons were rendered from the mark brand.ts draws today, at their size', () => {
  for (const icon of EXTENSION_ICONS) {
    const png = readFileSync(icon.path)
    assert.deepEqual(readPngSize(png), { width: icon.size, height: icon.size }, icon.path)
    assert.equal(readPngText(png, SOURCE_KEY), iconSourceHash(icon), `${icon.path} is ${REGENERATE}`)
  }
})

test('the macOS app icon was rendered from the mark brand.ts draws today', () => {
  const png = readFileSync(DESKTOP_ICON.path)
  assert.deepEqual(readPngSize(png), { width: 1024, height: 1024 })
  assert.equal(readPngText(png, SOURCE_KEY), desktopIconSourceHash(), `${DESKTOP_ICON.path} is ${REGENERATE}`)
})
