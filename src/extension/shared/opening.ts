export function openingTimes(duration: number): number[] {
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0
  const times = [0, 0.5, 1, 2, end * 0.1, end * 0.25].filter((t) => t === 0 || t < end)
  return [...new Set(times.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b)
}

export const BLANK_SAMPLE = 16
const FLAT = 4

export function isBlank(rgba: Uint8ClampedArray): boolean {
  const n = rgba.length / 4
  if (!n) return true
  let sum = 0
  let squares = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const luma = 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!
    sum += luma
    squares += luma * luma
  }
  const mean = sum / n
  return Math.sqrt(Math.max(0, squares / n - mean * mean)) < FLAT
}
