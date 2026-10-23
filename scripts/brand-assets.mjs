import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { brandLockupSvg, brandMarkSvg } from '../src/brand.ts'

export const README_LOCKUPS = [
  { path: 'docs/brand/ezdesign-light.svg', fill: '#171717' },
  { path: 'docs/brand/ezdesign-dark.svg', fill: '#f0f6fc' },
]

/** Chrome draws the 128 icon's art at 96 and leaves the rest as padding. */
export const EXTENSION_ICONS = [
  { size: 16, art: 16 },
  { size: 32, art: 32 },
  { size: 48, art: 48 },
  { size: 128, art: 96 },
].map((icon) => ({ ...icon, path: `src/extension/icons/icon-${icon.size}.png` }))

export const SOURCE_KEY = 'ezdesign:source'

export function lockupSource({ fill }) {
  return `${brandLockupSvg({ fill, height: 32 })}\n`
}

function iconPage({ size, art }) {
  const inset = (size - art) / 2
  return `<!doctype html><html><body style="margin:0;background:transparent"><div style="width:${art}px;height:${art}px;margin:${inset}px">${brandMarkSvg()}</div></body></html>`
}

/** What a raster was made from, so a stale copy can be caught without re-rendering it. */
export function iconSourceHash(icon) {
  return createHash('sha256').update(iconPage(icon)).digest('hex')
}

export function readPngText(bytes, keyword) {
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    if (type === 'tEXt') {
      const data = bytes.subarray(at + 8, at + 8 + length)
      const sep = data.indexOf(0)
      if (data.toString('latin1', 0, sep) === keyword) return data.toString('latin1', sep + 1)
    }
    at += 12 + length
  }
  return undefined
}

export function readPngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function withPngText(bytes, keyword, text) {
  const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from(`${keyword}\0${text}`, 'latin1')])
  const chunk = Buffer.alloc(body.length + 8)
  chunk.writeUInt32BE(body.length - 4, 0)
  body.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(body), body.length + 4)
  const afterHeader = 8 + 12 + bytes.readUInt32BE(8)
  return Buffer.concat([bytes.subarray(0, afterHeader), chunk, bytes.subarray(afterHeader)])
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

function renderPng(html, size) {
  const chrome = CHROME_CANDIDATES.find((path) => path && existsSync(path))
  if (!chrome) throw new Error('no Chrome found; set CHROME_PATH')
  const dir = mkdtempSync(join(tmpdir(), 'ezdesign-brand-'))
  try {
    const page = join(dir, 'page.html')
    const out = join(dir, 'out.png')
    writeFileSync(page, html)
    execFileSync(
      chrome,
      [
        '--headless',
        '--use-mock-keychain',
        '--password-store=basic',
        `--user-data-dir=${join(dir, 'profile')}`,
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${out}`,
        pathToFileURL(page).href,
      ],
      { stdio: 'ignore' },
    )
    const png = readFileSync(out)
    const actual = readPngSize(png)
    if (actual.width !== size || actual.height !== size) {
      throw new Error(`Chrome rendered ${actual.width}x${actual.height}, wanted ${size}x${size}`)
    }
    return png
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const lockup of README_LOCKUPS) writeFileSync(lockup.path, lockupSource(lockup))
  for (const icon of EXTENSION_ICONS) {
    writeFileSync(icon.path, withPngText(renderPng(iconPage(icon), icon.size), SOURCE_KEY, iconSourceHash(icon)))
  }
  console.log('brand assets ok')
}
