// Saves twelve varied references through the real extension in Chrome for Testing,
// then copies the library into a stack's data dir. Usage: seed-library.mts <data dir> <evidence dir>
import { cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { findChromeForTesting, launch, waitFor } from '../../../../test/e2e/harness.ts'

const [target, evidence] = process.argv.slice(2)
if (!target || !evidence) throw new Error('usage: seed-library.mts <data dir> <evidence dir>')

const toBase64 = `async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}`

interface Ref {
  title: string
  w: number
  h: number
  hue: number
  layout: 'hero' | 'cards' | 'mobile' | 'poster' | 'type' | 'dash'
  tags: string[]
  note: string
}

const refs: Ref[] = [
  { title: 'Linear - Plan and build products', w: 1600, h: 1000, hue: 250, layout: 'hero', tags: ['landing', 'dark', 'hero'], note: '標題字距收得很緊，漸層光暈很克制' },
  { title: 'Stripe Press', w: 1000, h: 1400, hue: 30, layout: 'poster', tags: ['editorial', 'typography'], note: '襯線大標配細內文，留白大方' },
  { title: 'Vercel Dashboard', w: 1600, h: 1000, hue: 210, layout: 'dash', tags: ['dashboard', 'dark'], note: '' },
  { title: 'Arc Browser - Mobile onboarding', w: 780, h: 1600, hue: 330, layout: 'mobile', tags: ['mobile', 'onboarding'], note: '每一步只問一件事' },
  { title: 'Raycast Pricing', w: 1600, h: 1100, hue: 10, layout: 'cards', tags: ['pricing', 'cards'], note: '三欄方案，中間那張用描邊強調而不是放大' },
  { title: 'Klim Type Foundry', w: 1400, h: 1400, hue: 50, layout: 'type', tags: ['typography'], note: '' },
  { title: 'Notion Calendar', w: 1600, h: 1000, hue: 140, layout: 'dash', tags: ['dashboard', 'calendar'], note: '週視圖的格線很淡' },
  { title: 'Apple Vision Pro', w: 2400, h: 900, hue: 280, layout: 'hero', tags: ['landing', 'hero'], note: '' },
  { title: 'Airbnb - Wishlists', w: 780, h: 1600, hue: 355, layout: 'mobile', tags: ['mobile', 'cards'], note: '圖片圓角和卡片陰影的比例' },
  { title: 'Framer Templates', w: 1600, h: 1200, hue: 190, layout: 'cards', tags: ['cards', 'grid'], note: '' },
  { title: 'Teenage Engineering', w: 1200, h: 1500, hue: 20, layout: 'poster', tags: ['editorial'], note: '產品照片去背放在灰底上' },
  { title: 'Figma Config 2026', w: 1600, h: 900, hue: 100, layout: 'type', tags: ['typography', 'landing'], note: '' },
]

async function main(): Promise<void> {
  const chrome = findChromeForTesting()
  if (!chrome) throw new Error('no Chrome for Testing')
  const h = await launch(chrome, { evidence, deviceScaleFactor: 2 })
  try {
    const blank = await h.openTab('about:blank')
    for (const [i, ref] of refs.entries()) {
      const data = await h.evaluate<string>(blank.session, `(async () => {
        const W = ${ref.w}, H = ${ref.h}, hue = ${ref.hue}, layout = ${JSON.stringify(ref.layout)}
        const c = new OffscreenCanvas(W, H)
        const x = c.getContext('2d')
        const dark = ${ref.tags.includes('dark')}
        const bg = dark ? 'hsl(' + hue + ' 18% 8%)' : 'hsl(' + hue + ' 30% 96%)'
        const ink = dark ? 'hsl(' + hue + ' 10% 92%)' : 'hsl(' + hue + ' 20% 12%)'
        const accent = 'hsl(' + hue + ' 75% 55%)'
        x.fillStyle = bg; x.fillRect(0, 0, W, H)
        const u = Math.min(W, H) / 20
        const round = (rx, ry, rw, rh, r, fill) => { x.beginPath(); x.roundRect(rx, ry, rw, rh, r); x.fillStyle = fill; x.fill() }
        if (layout === 'hero') {
          const g = x.createRadialGradient(W * 0.5, H * 0.1, 0, W * 0.5, H * 0.1, W * 0.6)
          g.addColorStop(0, 'hsl(' + hue + ' 80% 60% / 0.55)'); g.addColorStop(1, 'transparent')
          x.fillStyle = g; x.fillRect(0, 0, W, H)
          x.fillStyle = ink; x.font = '600 ' + (u * 2.6) + 'px -apple-system, sans-serif'; x.textAlign = 'center'
          x.fillText(${JSON.stringify(ref.title.split(' - ')[0])}, W / 2, H * 0.42)
          x.font = (u * 0.8) + 'px -apple-system, sans-serif'; x.globalAlpha = 0.6
          x.fillText('The system for modern product teams', W / 2, H * 0.52); x.globalAlpha = 1
          round(W / 2 - u * 3.2, H * 0.6, u * 6.4, u * 1.6, u * 0.8, accent)
          round(W * 0.15, H * 0.75, W * 0.7, H * 0.4, u * 0.6, dark ? 'hsl(' + hue + ' 15% 14%)' : '#fff')
        } else if (layout === 'cards') {
          x.fillStyle = ink; x.font = '700 ' + (u * 1.6) + 'px -apple-system, sans-serif'; x.textAlign = 'center'
          x.fillText('Simple pricing', W / 2, H * 0.18)
          for (let k = 0; k < 3; k++) {
            const cw = W * 0.26, cx = W * 0.08 + k * (cw + W * 0.03)
            round(cx, H * 0.28, cw, H * 0.6, u * 0.6, '#fff')
            if (k === 1) { x.strokeStyle = accent; x.lineWidth = 4; x.beginPath(); x.roundRect(cx, H * 0.28, cw, H * 0.6, u * 0.6); x.stroke() }
            x.fillStyle = ink; x.font = '600 ' + (u * 0.9) + 'px -apple-system, sans-serif'; x.textAlign = 'left'
            x.fillText(['Free', 'Pro', 'Team'][k], cx + u, H * 0.28 + u * 1.8)
            x.font = '700 ' + (u * 1.8) + 'px -apple-system, sans-serif'
            x.fillText(['$0', '$12', '$24'][k], cx + u, H * 0.28 + u * 4)
            for (let r = 0; r < 4; r++) round(cx + u, H * 0.28 + u * (5.5 + r * 1.2), cw * (0.5 + (r % 2) * 0.2), u * 0.35, 4, 'hsl(' + hue + ' 10% 88%)')
            round(cx + u, H * 0.28 + H * 0.6 - u * 2.6, cw - u * 2, u * 1.4, u * 0.4, k === 1 ? accent : 'hsl(' + hue + ' 15% 92%)')
          }
        } else if (layout === 'mobile') {
          round(W * 0.06, H * 0.03, W * 0.88, H * 0.94, u * 2, '#fff')
          const g = x.createLinearGradient(0, 0, W, H * 0.5)
          g.addColorStop(0, 'hsl(' + hue + ' 80% 70%)'); g.addColorStop(1, 'hsl(' + (hue + 40) + ' 70% 55%)')
          round(W * 0.12, H * 0.08, W * 0.76, H * 0.42, u * 1.2, g)
          x.fillStyle = ink; x.font = '700 ' + (u * 1.5) + 'px -apple-system, sans-serif'; x.textAlign = 'left'
          x.fillText('Welcome', W * 0.12, H * 0.6)
          x.font = (u * 0.75) + 'px -apple-system, sans-serif'; x.globalAlpha = 0.55
          x.fillText('Spaces keep your tabs tidy.', W * 0.12, H * 0.65); x.globalAlpha = 1
          round(W * 0.12, H * 0.82, W * 0.76, u * 2.2, u * 1.1, ink)
          for (let d = 0; d < 3; d++) round(W * 0.43 + d * u * 0.9, H * 0.76, u * (d === 0 ? 1.2 : 0.5), u * 0.5, u * 0.25, d === 0 ? accent : 'hsl(0 0% 85%)')
        } else if (layout === 'poster') {
          x.fillStyle = ink; x.font = 'italic 400 ' + (u * 3) + 'px Georgia, serif'; x.textAlign = 'left'
          x.fillText('Works', u * 1.5, H * 0.2); x.fillText('in Progress', u * 1.5, H * 0.2 + u * 3.2)
          round(u * 1.5, H * 0.38, W - u * 3, H * 0.4, 0, 'hsl(' + hue + ' 35% 82%)')
          round(W * 0.35, H * 0.45, W * 0.3, H * 0.26, W, accent)
          x.font = (u * 0.55) + 'px Georgia, serif'
          for (let r = 0; r < 5; r++) round(u * 1.5, H * 0.83 + r * u * 0.8, (W - u * 3) * (r === 4 ? 0.5 : 1), u * 0.25, 2, 'hsl(' + hue + ' 10% 75%)')
        } else if (layout === 'type') {
          x.fillStyle = ink; x.textAlign = 'left'
          x.font = '800 ' + (u * 7) + 'px -apple-system, sans-serif'; x.fillText('Aa', u * 1.2, H * 0.48)
          x.font = '300 ' + (u * 1.1) + 'px -apple-system, sans-serif'
          x.fillText('ABCDEFGHIJKLMNOPQRSTUVWXYZ', u * 1.2, H * 0.66)
          x.fillText('abcdefghijklmnopqrstuvwxyz 0123456789', u * 1.2, H * 0.74)
          round(W - u * 5, u * 1.2, u * 3.6, u * 3.6, u * 1.8, accent)
        } else {
          round(0, 0, W * 0.18, H, 0, dark ? 'hsl(' + hue + ' 15% 11%)' : 'hsl(' + hue + ' 20% 92%)')
          for (let r = 0; r < 7; r++) round(u * 0.8, u * (2 + r * 1.3), W * 0.18 - u * 1.6, u * 0.7, 6, r === 1 ? accent : (dark ? 'hsl(0 0% 20%)' : 'hsl(0 0% 84%)'))
          for (let k = 0; k < 3; k++) round(W * 0.21 + k * W * 0.26, u * 1.5, W * 0.24, H * 0.22, u * 0.4, dark ? 'hsl(' + hue + ' 12% 13%)' : '#fff')
          x.strokeStyle = accent; x.lineWidth = 5; x.beginPath()
          for (let p = 0; p <= 30; p++) { const px = W * 0.23 + p * (W * 0.72 / 30), py = H * 0.75 - Math.sin(p / 4 + hue) * H * 0.12 - p * H * 0.006; p ? x.lineTo(px, py) : x.moveTo(px, py) }
          x.stroke()
        }
        return (${toBase64})(await c.convertToBlob({ type: 'image/png' }))
      })()`)
      const path = `/ref-${i}.png`
      h.fixtures.serve(path, { type: 'image/png', body: Buffer.from(data, 'base64') })
      const src = `${h.fixtures.cross}${path}`
      const pagePath = `/page-${i}`
      h.fixtures.serve(pagePath, {
        type: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><meta charset="utf-8"><title>${ref.title}</title></head><body style="margin:0"><img src="${src}" style="max-width:800px;max-height:700px"></body></html>`,
      })
      const page = await h.openTab(`${h.fixtures.same}${pagePath}`)
      await page.grantActiveTab()
      const id = await page.saveFromMenu(src, 'image')
      const dialog = await page.dialog(id)
      for (const tag of ref.tags) {
        await dialog.type(tag)
        await dialog.press('Enter')
      }
      if (ref.note) {
        await dialog.evaluate(`document.querySelector('[data-testid=ez-capture-note]').focus()`)
        await dialog.type(ref.note)
      }
      await waitFor(() => dialog.evaluate<boolean>(`!document.querySelector('[data-testid=ez-capture-save]').disabled`), 'save enabled', 30_000)
      await dialog.click('ez-capture-save')
      const outcome = await h.inWorker<{ type: string }>(`__ezCapture.settled(${JSON.stringify(id)})`)
      console.log(`${ref.title}: ${outcome.type}`)
    }
    rmSync(join(target, 'library'), { recursive: true, force: true })
    cpSync(join(h.dataDir, 'library'), join(target, 'library'), { recursive: true, filter: (p) => !p.includes('/staging/') })
    console.log(`copied to ${join(target, 'library')}`)
  } finally {
    await h.dispose()
  }
}

await main()
