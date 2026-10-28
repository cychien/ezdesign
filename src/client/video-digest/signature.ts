const SIGNATURE_LONG_SIDE = 256
const CELL = 8
const PIXEL_THRESHOLD = 12
const CELL_MIN_PIXELS = 2

export interface SignatureGrid {
  width: number
  height: number
  cols: number
  rows: number
  scaleX: number
  scaleY: number
}

export interface CellBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface FrameChange {
  t: number
  regions: CellBox[]
}

export function signatureGrid(video: { width: number; height: number }): SignatureGrid {
  const scale = SIGNATURE_LONG_SIDE / Math.max(video.width, video.height)
  const cols = Math.max(1, Math.round((video.width * scale) / CELL))
  const rows = Math.max(1, Math.round((video.height * scale) / CELL))
  return {
    width: cols * CELL,
    height: rows * CELL,
    cols,
    rows,
    scaleX: video.width / cols,
    scaleY: video.height / rows,
  }
}

export function changedRegions(
  prev: Uint8ClampedArray,
  next: Uint8ClampedArray,
  grid: SignatureGrid,
): CellBox[] {
  const { width, height, cols, rows } = grid
  const counts = new Uint16Array(cols * rows)
  for (let y = 0; y < height; y++) {
    const rowCell = ((y / CELL) | 0) * cols
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const d = Math.max(
        Math.abs(next[i]! - prev[i]!),
        Math.abs(next[i + 1]! - prev[i + 1]!),
        Math.abs(next[i + 2]! - prev[i + 2]!),
      )
      if (d > PIXEL_THRESHOLD) counts[rowCell + ((x / CELL) | 0)]!++
    }
  }
  const changed = (c: number) => counts[c]! >= CELL_MIN_PIXELS
  const seen = new Uint8Array(cols * rows)
  const regions: CellBox[] = []
  const stack: number[] = []
  for (let start = 0; start < counts.length; start++) {
    if (seen[start] || !changed(start)) continue
    const box = { x0: cols, y0: rows, x1: -1, y1: -1 }
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const c = stack.pop()!
      const cx = c % cols
      const cy = (c / cols) | 0
      box.x0 = Math.min(box.x0, cx)
      box.y0 = Math.min(box.y0, cy)
      box.x1 = Math.max(box.x1, cx)
      box.y1 = Math.max(box.y1, cy)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const n = ny * cols + nx
          if (seen[n] || !changed(n)) continue
          seen[n] = 1
          stack.push(n)
        }
      }
    }
    regions.push(box)
  }
  return regions
}
