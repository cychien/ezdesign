import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_KEY, readPngText, renderPng, withPngText } from '../../scripts/brand-assets.mjs'
import { brandLockupSvg } from '../../src/brand'
import { MESSAGES, type Locale } from '../src/i18n/locales'
import { AGENT_LOGOS } from '../src/lib/agents'
import { INSTALL } from '../src/lib/links'
import { OG_IMAGE, ogImagePath } from '../src/lib/og'

const fontDataUrl = (path: string) =>
  `data:font/woff2;base64,${readFileSync(new URL(`../node_modules/${path}`, import.meta.url)).toString('base64')}`

const GEIST = fontDataUrl('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2')
const GEIST_MONO = fontDataUrl('@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2')

const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='g' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E")`

function ogPage(locale: Locale): string {
  const { lang, meta, hero } = MESSAGES[locale]
  const logos = AGENT_LOGOS.map(({ path, fill }) => `<svg viewBox="0 0 24 24" fill="${fill}"><path d="${path}"/></svg>`).join('')
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<style>
  @font-face { font-family: 'Geist'; font-weight: 100 900; src: url(${GEIST}) format('woff2'); }
  @font-face { font-family: 'Geist Mono'; font-weight: 100 900; src: url(${GEIST_MONO}) format('woff2'); }
  :root { --ink: #171717; --muted: #676767; --faint: #878787; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    position: relative; isolation: isolate; overflow: hidden;
    width: ${OG_IMAGE.width}px; height: ${OG_IMAGE.height}px;
    background: #faf9f6; color: var(--ink);
    font-family: 'Geist', 'PingFang TC', 'Noto Sans TC', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .glow {
    position: absolute; inset: -10%; z-index: -2; filter: blur(40px);
    background:
      radial-gradient(30% 40% at 96% 96%, rgba(229, 109, 65, 0.8) 0%, rgba(229, 109, 65, 0) 70%),
      radial-gradient(40% 55% at 86% 70%, #d98b6a 0%, rgba(217, 139, 106, 0) 70%),
      radial-gradient(38% 50% at 70% 4%, #eadfb8 0%, rgba(234, 223, 184, 0) 70%),
      radial-gradient(34% 46% at 56% 100%, #f1d2c4 0%, rgba(241, 210, 196, 0) 72%);
    mask-image: linear-gradient(105deg, transparent 40%, #000 75%);
  }
  .noise { position: absolute; inset: 0; z-index: -1; opacity: 0.22; mix-blend-mode: overlay; background: ${NOISE}; background-size: 200px; }
  .page { position: absolute; inset: 72px 80px; display: flex; flex-direction: column; }
  .lockup svg { display: block; }
  h1 { margin: auto 0 0; max-width: 900px; font-size: 84px; font-weight: 600; line-height: 1; letter-spacing: -0.05em; }
  :lang(zh) h1 { font-size: 80px; line-height: 1.12; letter-spacing: -0.01em; }
  .foot { display: flex; align-items: center; gap: 20px; margin-top: 44px; }
  .cmd { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 22px; border-radius: 12px; background: var(--ink); color: #fff; font: 21px 'Geist Mono', monospace; }
  .cmd span { color: var(--faint); }
  .local { display: flex; align-items: center; gap: 14px; font-size: 21px; color: var(--muted); }
  .logos { display: flex; gap: 10px; }
  .logos svg { display: block; width: 24px; height: 24px; }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="noise"></div>
  <div class="page">
    <div class="lockup">${brandLockupSvg({ height: 36 })}</div>
    <h1>${hero.title}</h1>
    <div class="foot">
      <div class="cmd"><span>$</span>${INSTALL}</div>
      <div class="local"><span class="logos">${logos}</span><span>${meta.ogTagline}</span></div>
    </div>
  </div>
</body>
</html>
`
}

const check = process.argv.includes('--check')
const stale: string[] = []

for (const locale of Object.keys(MESSAGES) as Locale[]) {
  const file = fileURLToPath(new URL(`../public${ogImagePath(locale)}`, import.meta.url))
  const page = ogPage(locale)
  const hash = createHash('sha256').update(page).digest('hex')
  if (check) {
    if (!existsSync(file) || readPngText(readFileSync(file), SOURCE_KEY) !== hash) stale.push(file)
    continue
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, withPngText(renderPng(page, OG_IMAGE.width, OG_IMAGE.height), SOURCE_KEY, hash))
}

if (stale.length) {
  console.error(`stale: run \`pnpm --filter ezdesign-website run og\`\n${stale.join('\n')}`)
  process.exitCode = 1
}
