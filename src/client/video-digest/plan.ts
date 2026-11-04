import { MAX_SHEETS } from '../../attachment-wire.js'
import type { MotionStretch, VideoRect } from '../../protocol.js'
import type { CellBox, FrameChange, SignatureGrid } from './signature.js'

/** Claude scales an image down past this on its long side, so pixels past it
 *  are spent for nothing. */
const SHEET_LONG_SIDE = 1568
const MOTION_CELLS = 24
const OVERVIEW_CELLS = 12
const LINK_GAP_US = 120_000
const POINTER_MAX_CELLS = 3
const POINTER_TRAVEL = 4
const AMBIENT_SHARE = 0.8
const MAX_UPSCALE = 3
const HEADER_PX = 28
const LABEL_PX = 18
const GUTTER_PX = 6

export interface Clip {
  width: number
  height: number
  grid: SignatureGrid
  frames: FrameChange[]
  durationUs: number
}

export interface DigestPlan {
  sheets: SheetPlan[]
  motion: MotionStretch[]
  wanted: number[]
}

export interface SheetPlan {
  width: number
  height: number
  header: string
  cells: CellPlan[]
}

export interface CellPlan {
  t: number
  src: VideoRect
  dst: VideoRect
  pixelated: boolean
  label: string
  marks: { rect: VideoRect; text: string }[]
}

export function planDigest(clip: Clip): DigestPlan {
  const episodes = mergeConcurrent(trackEpisodes(clip), clip)
  const kinds = episodes.map((e) => kindOf(e, clip))
  const parts = partsOf(sheetEpisodes(episodes, kinds))
  const stretches = episodes.flatMap((e, i) => (kinds[i] === 'pointer' ? [] : splitEpisode(e, parts.get(e) ?? 1)))
  const sheeted = stretches.filter((s) => parts.has(s.episode))
  const sheetOf = new Map(sheeted.map((s, i) => [s, i + 2]))
  const motion: MotionStretch[] = stretches.map((s) => {
    const sheet = sheetOf.get(s) ?? null
    return {
      fromMs: Math.round(clip.frames[beforeOf(s) ?? s.frames[0]!]!.t / 1000),
      toMs: Math.round(clip.frames[s.frames.at(-1)!]!.t / 1000),
      region: cropOf(s.episode, clip),
      frames: s.frames.length,
      shown: sheet === null ? 0 : motionFrames(s, clip).filter((f) => f !== beforeOf(s)).length,
      sheet,
    }
  })
  const marks = new Map(
    sheeted
      .filter((s) => s.part === 1)
      .map((s) => {
        const first = sheetOf.get(s)!
        return [s.episode, s.parts > 1 ? `${first}-${first + s.parts - 1}` : String(first)]
      }),
  )
  const sheets = [
    overviewSheet(clip, episodes, kinds, marks),
    ...sheeted.map((s) => motionSheet(clip, s, sheetOf.get(s)!)),
  ]
  const wanted = [...new Set(sheets.flatMap((sheet) => sheet.cells.map((c) => c.t)))].sort((x, y) => x - y)
  return { sheets, motion, wanted }
}

interface Episode {
  frames: number[]
  union: CellBox
  areaSum: number
  largest: number
}

type EpisodeKind = 'event' | 'ambient' | 'pointer'

/** One sheet's share of an episode: a long one runs on over consecutive parts. */
interface Stretch {
  episode: Episode
  frames: number[]
  part: number
  parts: number
}

const area = (b: CellBox): number => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1)
const overlaps = (a: CellBox, b: CellBox): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1
const unite = (a: CellBox, b: CellBox): CellBox => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
})
const dilate = (b: CellBox): CellBox => ({ x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 })
const join = (a: Episode, b: Episode): Episode => ({
  frames: [...new Set([...a.frames, ...b.frames])].sort((x, y) => x - y),
  union: unite(a.union, b.union),
  areaSum: a.areaSum + b.areaSum,
  largest: Math.max(a.largest, b.largest),
})

function beforeOf(s: Stretch): number | null {
  return s.frames[0]! > 0 ? s.frames[0]! - 1 : null
}

function trackEpisodes(clip: Clip): Episode[] {
  const episodes: Episode[] = []
  clip.frames.forEach((frame, i) => {
    for (const region of frame.regions) {
      const reach = dilate(region)
      const matches = episodes.filter(
        (e) => frame.t - clip.frames[e.frames.at(-1)!]!.t < LINK_GAP_US && overlaps(e.union, reach),
      )
      const size = Math.max(region.x1 - region.x0 + 1, region.y1 - region.y0 + 1)
      if (!matches.length) {
        episodes.push({ frames: [i], union: region, areaSum: area(region), largest: size })
        continue
      }
      const [into, ...rest] = matches
      for (const other of rest) {
        Object.assign(into!, join(into!, other))
        episodes.splice(episodes.indexOf(other), 1)
      }
      if (into!.frames.at(-1) !== i) into!.frames.push(i)
      into!.union = unite(into!.union, region)
      into!.areaSum += area(region)
      into!.largest = Math.max(into!.largest, size)
    }
  })
  return episodes.sort((x, y) => x.frames[0]! - y.frames[0]!)
}

/** The tracker links a region only to episodes that already reach it, so the first
 *  flickers of a motion that later grows over them are left as episodes of their own. */
function mergeConcurrent(episodes: Episode[], clip: Clip): Episode[] {
  const t = (i: number) => clip.frames[i]!.t
  const concurrent = (a: Episode, b: Episode) =>
    t(a.frames[0]!) - t(b.frames.at(-1)!) < LINK_GAP_US && t(b.frames[0]!) - t(a.frames.at(-1)!) < LINK_GAP_US
  const merged = [...episodes]
  for (let i = 0; i < merged.length; i++) {
    for (let j = i + 1; j < merged.length; j++) {
      if (!concurrent(merged[i]!, merged[j]!) || !overlaps(dilate(merged[i]!.union), merged[j]!.union)) continue
      merged[i] = join(merged[i]!, merged[j]!)
      merged.splice(j, 1)
      j = i
    }
  }
  return merged.sort((x, y) => x.frames[0]! - y.frames[0]!)
}

function kindOf(episode: Episode, clip: Clip): EpisodeKind {
  const meanRegion = episode.areaSum / episode.frames.length
  if (episode.largest <= POINTER_MAX_CELLS && area(episode.union) >= POINTER_TRAVEL * meanRegion) return 'pointer'
  const span = clip.frames[episode.frames.at(-1)!]!.t - clip.frames[episode.frames[0]!]!.t
  return clip.durationUs > 0 && span >= AMBIENT_SHARE * clip.durationUs ? 'ambient' : 'event'
}

function sheetEpisodes(episodes: Episode[], kinds: EpisodeKind[]): Episode[] {
  const weight = (e: Episode) => area(e.union) * Math.min(e.frames.length, MOTION_CELLS)
  const ranked = (kind: EpisodeKind) =>
    episodes.filter((_, i) => kinds[i] === kind).sort((x, y) => weight(y) - weight(x))
  const ambient = ranked('ambient')
  const room = MAX_SHEETS - 1
  const chosen = new Set([...ranked('event').slice(0, room - Math.min(1, ambient.length)), ...ambient].slice(0, room))
  return episodes.filter((e) => chosen.has(e))
}

/** Sheets no episode claimed go to whichever has the most changed frames per sheet
 *  until each shows every frame, so a clip of one long motion is not left at 24 cells. */
function partsOf(chosen: Episode[]): Map<Episode, number> {
  const parts = new Map(chosen.map((e) => [e, 1]))
  const crowding = (e: Episode) => e.frames.length / parts.get(e)!
  for (let spare = MAX_SHEETS - 1 - chosen.length; spare > 0; spare--) {
    const most = chosen.reduce<Episode | null>((best, e) => (!best || crowding(e) > crowding(best) ? e : best), null)
    if (!most || crowding(most) <= MOTION_CELLS - 1) break
    parts.set(most, parts.get(most)! + 1)
  }
  return parts
}

function splitEpisode(episode: Episode, parts: number): Stretch[] {
  const cut = (k: number) => Math.round((k * episode.frames.length) / parts)
  return Array.from({ length: parts }, (_, k) => ({
    episode,
    frames: episode.frames.slice(cut(k), cut(k + 1)),
    part: k + 1,
    parts,
  }))
}

function cropOf(episode: Episode, clip: Clip): VideoRect {
  const { scaleX, scaleY } = clip.grid
  let x0 = Math.max(0, (episode.union.x0 - 1) * scaleX)
  let y0 = Math.max(0, (episode.union.y0 - 1) * scaleY)
  let x1 = Math.min(clip.width, (episode.union.x1 + 2) * scaleX)
  let y1 = Math.min(clip.height, (episode.union.y1 + 2) * scaleY)
  const grow = (lo: number, hi: number, want: number, max: number): [number, number] => {
    const extra = (want - (hi - lo)) / 2
    let a = lo - extra
    let b = hi + extra
    if (a < 0) [a, b] = [0, b - a]
    if (b > max) [a, b] = [Math.max(0, a - (b - max)), max]
    return [a, b]
  }
  if (x1 - x0 > 4 * (y1 - y0)) [y0, y1] = grow(y0, y1, (x1 - x0) / 4, clip.height)
  else if (y1 - y0 > 4 * (x1 - x0)) [x0, x1] = grow(x0, x1, (y1 - y0) / 4, clip.width)
  const x = Math.floor(x0)
  const y = Math.floor(y0)
  return { x, y, width: Math.min(clip.width, Math.ceil(x1)) - x, height: Math.min(clip.height, Math.ceil(y1)) - y }
}

function motionFrames(stretch: Stretch, clip: Clip): number[] {
  const before = beforeOf(stretch)
  const room = MOTION_CELLS - (before === null ? 0 : 1)
  const changed = stretch.frames.length > room ? spreadInTime(stretch.frames, room, clip) : stretch.frames
  return before === null ? changed : [before, ...changed]
}

function spreadInTime(frames: number[], count: number, clip: Clip): number[] {
  const t = (i: number) => clip.frames[i]!.t
  const first = t(frames[0]!)
  const last = t(frames.at(-1)!)
  const picked = new Set<number>([frames[0]!, frames.at(-1)!])
  let cursor = 0
  for (let k = 1; k < count - 1; k++) {
    const target = first + ((last - first) * k) / (count - 1)
    while (cursor < frames.length - 1 && Math.abs(t(frames[cursor + 1]!) - target) <= Math.abs(t(frames[cursor]!) - target)) {
      cursor++
    }
    picked.add(frames[cursor]!)
  }
  return [...picked].sort((x, y) => x - y)
}

const secondsLabel = (us: number): string => `${(us / 1e6).toFixed(3)} s`

function motionSheet(clip: Clip, stretch: Stretch, sheet: number): SheetPlan {
  const src = cropOf(stretch.episode, clip)
  const frames = motionFrames(stretch, clip)
  const before = beforeOf(stretch)
  const changed = frames.filter((f) => f !== before).length
  const layout = layOut(frames.length, src)
  const from = clip.frames[before ?? stretch.frames[0]!]!.t
  const to = clip.frames[stretch.frames.at(-1)!]!.t
  const which =
    changed === stretch.frames.length ? `every changed frame (${changed})` : `${changed} of ${stretch.frames.length} changed frames, evenly spaced`
  const part = stretch.parts > 1 ? ` · part ${stretch.part} of ${stretch.parts}` : ''
  return {
    width: layout.width,
    height: layout.height,
    header:
      `sheet ${sheet} · motion ${(from / 1e6).toFixed(3)}-${(to / 1e6).toFixed(3)} s${part} · ` +
      `x ${src.x} y ${src.y}, ${src.width}x${src.height} · ${which}`,
    cells: frames.map((f, i) => {
      const at = layout.at(i)
      return {
        t: clip.frames[f]!.t,
        src,
        dst: { x: at.x, y: at.y, width: layout.cellWidth, height: layout.cellHeight },
        pixelated: layout.pixelated,
        label: f === before ? `${secondsLabel(clip.frames[f]!.t)} · before` : secondsLabel(clip.frames[f]!.t),
        marks: [],
      }
    }),
  }
}

function overviewSheet(clip: Clip, episodes: Episode[], kinds: EpisodeKind[], marks: Map<Episode, string>): SheetPlan {
  const last = clip.frames.length - 1
  const wanted: { frame: number; mark?: { episode: Episode; sheet: string } }[] = [{ frame: 0 }, { frame: last }]
  for (const [episode, sheet] of marks) wanted.push({ frame: episode.frames.at(-1)!, mark: { episode, sheet } })
  episodes.forEach((e, i) => {
    if (kinds[i] === 'event' && !marks.has(e)) wanted.push({ frame: e.frames.at(-1)! })
  })
  episodes.forEach((e, i) => {
    if (kinds[i] === 'pointer') wanted.push({ frame: e.frames.at(-1)! })
  })
  const byFrame = new Map<number, { episode: Episode; sheet: string }[]>()
  for (const w of wanted) {
    if (!byFrame.has(w.frame)) {
      if (byFrame.size >= OVERVIEW_CELLS) continue
      byFrame.set(w.frame, [])
    }
    if (w.mark) byFrame.get(w.frame)!.push(w.mark)
  }
  const frames = [...byFrame.keys()].sort((x, y) => x - y)
  const src: VideoRect = { x: 0, y: 0, width: clip.width, height: clip.height }
  const layout = layOut(frames.length, src)
  const scale = layout.cellWidth / clip.width
  return {
    width: layout.width,
    height: layout.height,
    header: `sheet 1 · overview · ${(clip.durationUs / 1e6).toFixed(3)} s · ${clip.width}x${clip.height} · numbered boxes have a sheet of their own`,
    cells: frames.map((f, i) => {
      const at = layout.at(i)
      return {
        t: clip.frames[f]!.t,
        src,
        dst: { x: at.x, y: at.y, width: layout.cellWidth, height: layout.cellHeight },
        pixelated: false,
        label: secondsLabel(clip.frames[f]!.t),
        marks: byFrame.get(f)!.map(({ episode, sheet }) => {
          const r = cropOf(episode, clip)
          return {
            rect: {
              x: Math.round(at.x + r.x * scale),
              y: Math.round(at.y + r.y * scale),
              width: Math.max(1, Math.round(r.width * scale)),
              height: Math.max(1, Math.round(r.height * scale)),
            },
            text: sheet,
          }
        }),
      }
    }),
  }
}

function layOut(
  count: number,
  src: { width: number; height: number },
): {
  width: number
  height: number
  cellWidth: number
  cellHeight: number
  pixelated: boolean
  at: (i: number) => { x: number; y: number }
} {
  const n = Math.max(1, count)
  let best = { cols: 1, scale: 0 }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const byWidth = (SHEET_LONG_SIDE - GUTTER_PX * (cols + 1)) / cols / src.width
    const byHeight = (SHEET_LONG_SIDE - HEADER_PX - GUTTER_PX * (rows + 1) - LABEL_PX * rows) / rows / src.height
    const scale = Math.min(byWidth, byHeight, MAX_UPSCALE)
    if (scale > best.scale) best = { cols, scale }
  }
  const pixelated = best.scale >= 2
  const scale = pixelated ? Math.floor(best.scale) : best.scale
  const cols = best.cols
  const rows = Math.ceil(n / cols)
  const cellWidth = Math.max(1, Math.floor(src.width * scale))
  const cellHeight = Math.max(1, Math.floor(src.height * scale))
  return {
    width: GUTTER_PX * (cols + 1) + cols * cellWidth,
    height: HEADER_PX + GUTTER_PX * (rows + 1) + rows * (LABEL_PX + cellHeight),
    cellWidth,
    cellHeight,
    pixelated,
    at: (i) => ({
      x: GUTTER_PX + (i % cols) * (cellWidth + GUTTER_PX),
      y: HEADER_PX + GUTTER_PX + Math.floor(i / cols) * (LABEL_PX + cellHeight + GUTTER_PX) + LABEL_PX,
    }),
  }
}
