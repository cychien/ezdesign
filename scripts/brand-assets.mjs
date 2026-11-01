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

/** Apple's macOS icon grid: an 824 px squircle on a 1024 canvas.
 *  electron-builder makes the .icns from build/icon.png by convention. */
export const DESKTOP_ICON = { size: 1024, path: 'desktop/build/icon.png' }

export const SOURCE_KEY = 'ezdesign:source'

export function lockupSource({ fill }) {
  return `${brandLockupSvg({ fill, height: 32 })}\n`
}

function iconPage({ size, art }) {
  const inset = (size - art) / 2
  return `<!doctype html><html><body style="margin:0;background:transparent"><div style="width:${art}px;height:${art}px;margin:${inset}px">${brandMarkSvg()}</div></body></html>`
}

const ICON_GRID = { canvas: 1024, tile: 824, radius: 185, mark: 620 }

export function desktopIconPage() {
  const { canvas, tile, radius, mark } = ICON_GRID
  const tileAt = (canvas - tile) / 2
  const markAt = (tile - mark) / 2
  return `<!doctype html><html><body style="margin:0;background:transparent"><div style="position:absolute;left:${tileAt}px;top:${tileAt}px;width:${tile}px;height:${tile}px;border-radius:${radius}px;background:linear-gradient(#fdfcf9,#f2f0e9);box-shadow:inset 0 0 0 2px rgba(0,0,0,0.06)"><div style="position:absolute;left:${markAt}px;top:${markAt}px;width:${mark}px;height:${mark}px">${brandMarkSvg()}</div></div></body></html>`
}

/** What a raster was made from, so a stale copy can be caught without re-rendering it. */
export function iconSourceHash(icon) {
  return createHash('sha256').update(iconPage(icon)).digest('hex')
}

export const desktopIconSourceHash = () => createHash('sha256').update(desktopIconPage()).digest('hex')

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

export function withPngText(bytes, keyword, text) {
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

export function renderPng(html, width, height = width) {
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
        `--window-size=${width},${height}`,
        `--screenshot=${out}`,
        pathToFileURL(page).href,
      ],
      { stdio: 'ignore' },
    )
    const png = readFileSync(out)
    const actual = readPngSize(png)
    if (actual.width !== width || actual.height !== height) {
      throw new Error(`Chrome rendered ${actual.width}x${actual.height}, wanted ${width}x${height}`)
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
  writeFileSync(DESKTOP_ICON.path, withPngText(renderPng(desktopIconPage(), DESKTOP_ICON.size), SOURCE_KEY, desktopIconSourceHash()))
  console.log('brand assets ok')
}
