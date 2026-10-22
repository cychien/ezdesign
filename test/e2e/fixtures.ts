import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Evaluate = <T>(expression: string) => Promise<T>

const toBase64 = `async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}`

export async function makeJpeg(evaluate: Evaluate, width: number, height: number, seed: number): Promise<Buffer> {
  const data = await evaluate<string>(`(async () => {
    const canvas = new OffscreenCanvas(${width}, ${height})
    const ctx = canvas.getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, ${width}, ${height})
    gradient.addColorStop(0, 'hsl(${seed * 47 % 360} 70% 60%)')
    gradient.addColorStop(1, 'hsl(${(seed * 47 + 160) % 360} 60% 35%)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, ${width}, ${height})
    const image = ctx.getImageData(0, 0, ${width}, ${height})
    let state = ${seed} * 2654435761 >>> 0
    for (let i = 0; i < image.data.length; i += 4) {
      state = (state * 1664525 + 1013904223) >>> 0
      const grain = (state >>> 24) - 128
      image.data[i] += grain * 0.5; image.data[i + 1] += grain * 0.45; image.data[i + 2] += grain * 0.55
    }
    ctx.putImageData(image, 0, 0)
    return (${toBase64})(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 }))
  })()`)
  return Buffer.from(data, 'base64')
}

export const clipFrameColor = (n: number) => `hsl(${(n * 23) % 360} 75% 50%)`
export const CLIP = { width: 1280, height: 720, fps: 10, frames: 50 }

export async function makeClip(evaluate: Evaluate, ffmpeg: string, dir: string): Promise<{ webm: Buffer; frame(n: number): Buffer }> {
  const framesDir = join(dir, 'frames')
  const out = join(dir, 'clip.webm')
  if (!existsSync(out)) {
    mkdirSync(framesDir, { recursive: true })
    const frames = await evaluate<string[]>(`(async () => {
      const out = []
      for (let n = 0; n < ${CLIP.frames}; n++) {
        const canvas = new OffscreenCanvas(${CLIP.width}, ${CLIP.height})
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = (${clipFrameColor.toString()})(n)
        ctx.fillRect(0, 0, ${CLIP.width}, ${CLIP.height})
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
        ctx.fillRect(80, 80, 360, 200)
        ctx.fillStyle = '#111'
        ctx.font = 'bold 140px sans-serif'
        ctx.fillText(String(n).padStart(2, '0'), 120, 235)
        out.push(await (${toBase64})(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })))
      }
      return out
    })()`)
    frames.forEach((data, n) => writeFileSync(join(framesDir, `${String(n).padStart(3, '0')}.jpg`), Buffer.from(data, 'base64')))
    // This ffmpeg has the image2pipe demuxer only, so the frames go in on stdin.
    const run = spawnSync(
      ffmpeg,
      ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(CLIP.fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
        '-c:v', 'libvpx', '-b:v', '6M', '-g', String(CLIP.fps), '-auto-alt-ref', '0', out],
      { input: Buffer.concat(frames.map((data) => Buffer.from(data, 'base64'))), encoding: 'utf8', maxBuffer: 1 << 28 },
    )
    if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`)
  }
  return {
    webm: readFileSync(out),
    frame: (n) => readFileSync(join(framesDir, `${String(n).padStart(3, '0')}.jpg`)),
  }
}
