/** The HTTP faces of canvases: the shell's routes on the session origin, and the
 *  frame host that serves frame documents on their own origin.
 *
 *  Shell routes, relative to the api router (so behind `refuseCrossSite`):
 *
 *      GET    /canvases/:canvasId                 -> CanvasWire
 *      POST   /canvases            {name?}        -> CanvasWire        (the tab strip's +)
 *      PATCH  /canvases/:canvasId  {name}         -> CanvasWire
 *      POST   /canvases/:canvasId/archive         -> {result: 'archived' | 'deleted'}
 *      POST   /canvases/:canvasId/reopen          -> CanvasWire
 *      DELETE /canvases/:canvasId                 -> {ok: true}        (archived only, else 409)
 *      POST   /canvases/:canvasId/ops  LayoutStepWire -> CanvasWire
 *      POST   /canvases/:canvasId/frames DuplicateWire -> CanvasWire
 *      POST   /canvases/:canvasId/assets  <image bytes> -> AssetWire
 *      POST   /canvases/:canvasId/image-frames ImageFrameWire -> CanvasWire
 *      PUT    /view                ViewWire       -> {ok: true}
 *
 *  Errors are `{error, code}` with `statusOf(problem)`. Every route parses at the
 *  boundary and makes one port call; the host gets only `UserCanvasPort` and the
 *  reader, so no route can write a document.
 *
 *  Frame host (`Host: localhost:<port>`), see `frameHost`:
 *
 *      GET    /__ezdesign/frames/:canvasId/:frameId?rev=   -> the stamped document
 *      GET    /__ezdesign/frames/:canvasId/assets/:name    -> an image a frame shows */

import express, { type Request, type RequestHandler, type Response, Router } from 'express'
import { URL_PREFIX } from '../constants.js'
import { FRAME_ROUTE, isFrameHost } from './frame-document.js'
import {
  type CanvasProblem,
  type FrameId,
  MAX_IMAGE_BYTES,
  type Outcome,
  type Point,
  type Rect,
  ZOOM_MAX,
  ZOOM_MIN,
  asAssetName,
  asCanvasId,
  asFrameId,
  asTabId,
} from './types.js'
import type { AssetWire, DuplicateWire, ImageFrameWire, LayoutOp, LayoutStepWire, OpId, ViewWire } from './wire.js'
import type { CanvasReader, UserCanvasPort } from './workspace.js'

export interface CanvasRouteHost {
  readonly user: UserCanvasPort
  readonly read: CanvasReader
}

/** The words a person (or the shell's notice) reads for a refusal. */
export function problemText(problem: CanvasProblem): string {
  switch (problem.code) {
    case 'CANVAS_NOT_FOUND':
      return `no canvas ${problem.canvasId}`
    case 'CANVAS_ARCHIVED':
      return `canvas ${problem.name} is closed`
    case 'FRAME_NOT_FOUND':
      return `no frame ${problem.frameId} on canvas ${problem.canvasId}`
    case 'FRAME_CONFLICT':
      return `frame ${problem.frameId} changed since it was read`
    case 'HTML_EMPTY':
      return 'the frame html is empty'
    case 'HTML_TOO_LARGE':
      return `the frame html is ${problem.bytes} bytes; the limit is ${problem.limit}`
    case 'NOT_A_DOCUMENT':
      return 'the frame html is not a complete document'
    case 'TOO_MANY_FRAMES':
      return `a canvas holds at most ${problem.limit} frames`
    case 'BAD_NAME':
      return `a name is 1 to ${problem.max} characters`
    case 'BAD_RECT':
      return `bad frame geometry: ${problem.reason}`
    case 'IMAGE_UNSUPPORTED':
      return `${problem.mime || 'this file'} is not an image a frame can show`
    case 'IMAGE_TOO_LARGE':
      return `the image is ${problem.bytes} bytes; the limit is ${problem.limit}`
    case 'IMAGE_EMPTY':
      return 'the image is empty'
    case 'ASSET_NOT_FOUND':
      return `no image ${problem.asset} on canvas ${problem.canvasId}`
  }
}

export function statusOf(problem: CanvasProblem): 400 | 404 | 409 | 413 | 415 {
  switch (problem.code) {
    case 'CANVAS_NOT_FOUND':
    case 'FRAME_NOT_FOUND':
    case 'ASSET_NOT_FOUND':
      return 404
    case 'CANVAS_ARCHIVED':
    case 'FRAME_CONFLICT':
      return 409
    case 'HTML_TOO_LARGE':
    case 'IMAGE_TOO_LARGE':
      return 413
    case 'IMAGE_UNSUPPORTED':
      return 415
    case 'HTML_EMPTY':
    case 'IMAGE_EMPTY':
    case 'NOT_A_DOCUMENT':
    case 'TOO_MANY_FRAMES':
    case 'BAD_NAME':
    case 'BAD_RECT':
      return 400
  }
}

function answer<T>(res: Response, outcome: Outcome<T>, body: (value: T) => unknown): void {
  if (outcome.ok) {
    res.json(body(outcome.value))
    return
  }
  res.status(statusOf(outcome.problem)).json({ error: problemText(outcome.problem), code: outcome.problem.code })
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function parseView(raw: unknown): ViewWire | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { activeTab, camera } = raw as Record<string, unknown>
  const view: ViewWire = {}
  if (activeTab !== undefined) {
    const tab = asTabId(activeTab)
    if (!tab) return null
    view.activeTab = tab
  }
  if (camera !== undefined) {
    if (typeof camera !== 'object' || camera === null) return null
    const { canvasId, camera: at } = camera as Record<string, unknown>
    const id = asCanvasId(canvasId)
    const { x, y, zoom } = (at ?? {}) as Record<string, unknown>
    if (!id || !finite(x) || !finite(y) || !finite(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX) return null
    view.camera = { canvasId: id, camera: { x, y, zoom } }
  }
  return view
}

function point(raw: unknown): Point | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { x, y } = raw as Record<string, unknown>
  return finite(x) && finite(y) ? { x, y } : null
}

function frameIds(raw: unknown): FrameId[] | null {
  if (!Array.isArray(raw)) return null
  const ids = raw.map(asFrameId)
  return ids.every((id): id is FrameId => id !== null) ? ids : null
}

/** A step off the wire, or null for a malformed one (400). Ids through
 *  `asFrameId`, positions checked finite here and normalized by the workspace. */
export function parseLayoutStep(raw: unknown): LayoutStepWire | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { opId, ops } = raw as Record<string, unknown>
  if (typeof opId !== 'string' || !/^[\w-]{1,64}$/.test(opId) || !Array.isArray(ops) || ops.length > 512) return null
  const parsed: LayoutOp[] = []
  for (const op of ops as Record<string, unknown>[]) {
    if (op?.t === 'move' && Array.isArray(op.frames)) {
      const frames = (op.frames as Record<string, unknown>[]).map((f) => {
        const id = asFrameId(f?.id)
        const at = point(f)
        return id && at ? { id, ...at } : null
      })
      if (frames.some((f) => f === null)) return null
      parsed.push({ t: 'move', frames: frames as ({ id: FrameId } & Point)[] })
    } else if (op?.t === 'remove' || op?.t === 'restore') {
      const ids = frameIds(op.ids)
      if (!ids) return null
      parsed.push({ t: op.t, ids })
    } else {
      return null
    }
  }
  return { opId: opId as OpId, ops: parsed }
}

export function parseDuplicate(raw: unknown): DuplicateWire | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { from, id, at: rawAt } = raw as Record<string, unknown>
  const source = asFrameId(from)
  const copy = asFrameId(id)
  const at = rawAt === undefined ? undefined : point(rawAt)
  if (!source || !copy || at === null) return null
  return { from: source, id: copy, ...(at ? { at } : {}) }
}

function rect(raw: unknown): Rect | null {
  const at = point(raw)
  const { width, height } = (raw ?? {}) as Record<string, unknown>
  return at && finite(width) && finite(height) ? { ...at, width, height } : null
}

export function parseImageFrame(raw: unknown): ImageFrameWire | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id: rawId, asset: rawAsset, title, rect: rawRect } = raw as Record<string, unknown>
  const id = asFrameId(rawId)
  const asset = asAssetName(rawAsset)
  const at = rect(rawRect)
  if (!id || !asset || !at || typeof title !== 'string') return null
  return { id, asset, title, rect: at }
}

const rawImage = express.raw({ type: () => true, limit: MAX_IMAGE_BYTES })

/** The body as bytes, whatever its type, refused past the image limit before a
 *  byte is buffered when the length is declared. */
function receiveImage(req: Request, res: Response, then: (bytes: Buffer) => void): void {
  if (Number(req.get('content-length')) > MAX_IMAGE_BYTES) {
    return void res.status(413).json({ error: 'the image is too large', code: 'IMAGE_TOO_LARGE' })
  }
  rawImage(req, res, (err?: unknown) => {
    if (!err) return then(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))
    const status = (err as { status?: number }).status === 413 ? 413 : 400
    res.status(status).json({ error: status === 413 ? 'the image is too large' : 'unreadable image body' })
  })
}

export function canvasApiRouter(host: CanvasRouteHost): Router {
  const api = Router()
  const { user, read } = host

  api.get('/canvases/:canvasId', (req, res) => {
    const id = asCanvasId(req.params.canvasId)
    const wire = id ? read.wire(id) : null
    if (!wire) return res.status(404).json({ error: `no canvas ${req.params.canvasId}`, code: 'CANVAS_NOT_FOUND' })
    res.json(wire)
  })
  api.post('/canvases', (req, res) => {
    const name = (req.body as { name?: unknown } | undefined)?.name
    if (name !== undefined && typeof name !== 'string') return res.status(400).json({ error: 'name must be text' })
    answer(res, user.create(name), (wire) => wire)
  })
  api.patch('/canvases/:canvasId', (req, res) => {
    const name = (req.body as { name?: unknown } | undefined)?.name
    if (typeof name !== 'string') return res.status(400).json({ error: 'name must be text' })
    answer(res, user.rename(req.params.canvasId, name), (wire) => wire)
  })
  api.post('/canvases/:canvasId/archive', (req, res) => {
    answer(res, user.archive(req.params.canvasId), (result) => ({ result }))
  })
  api.post('/canvases/:canvasId/reopen', (req, res) => {
    answer(res, user.reopen(req.params.canvasId), (wire) => wire)
  })
  api.delete('/canvases/:canvasId', (req, res) => {
    answer(res, user.delete(req.params.canvasId), () => ({ ok: true }))
  })
  api.post('/canvases/:canvasId/ops', (req, res) => {
    const step = parseLayoutStep(req.body)
    if (!step) return res.status(400).json({ error: 'not a layout step' })
    answer(res, user.applyLayoutOps(req.params.canvasId, step), (wire) => wire)
  })
  api.post('/canvases/:canvasId/frames', (req, res) => {
    const input = parseDuplicate(req.body)
    if (!input) return res.status(400).json({ error: 'not a duplicate' })
    answer(res, user.duplicate(req.params.canvasId, input), (wire) => wire)
  })
  api.post('/canvases/:canvasId/assets', (req, res) => {
    const mime = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    receiveImage(req, res, (bytes) =>
      answer(res, user.addAsset(req.params.canvasId, mime, bytes), (asset): AssetWire => ({ asset })),
    )
  })
  api.post('/canvases/:canvasId/image-frames', (req, res) => {
    const input = parseImageFrame(req.body)
    if (!input) return res.status(400).json({ error: 'not an image frame' })
    answer(res, user.addImageFrame(req.params.canvasId, input), (wire) => wire)
  })
  api.put('/view', (req, res) => {
    const view = parseView(req.body)
    if (!view) return res.status(400).json({ error: 'not a view' })
    user.setView(view)
    res.json({ ok: true })
  })
  return api
}

const FRAMES_PATH = `${URL_PREFIX}${FRAME_ROUTE}/`

/** The first middleware of the session's app, and the whole frame-origin
 *  policy in one place:
 *
 *  - on the frame host: `GET /__ezdesign/frames/:canvasId/:frameId` answers the
 *    stamped document, cached `immutable` (the revision is in the url); a gone
 *    frame is 404. Every other method and path on this host is 404 - no shell,
 *    no api, no proxy - with a body that names the shell's real url.
 *  - on any other host: a path under `/__ezdesign/frames` is 404, so a frame
 *    document never runs on the shell's origin; everything else is `next()`.
 *
 *  `read` is null with canvases off: frame paths are 404 on every host. */
export function frameHost(read: CanvasReader, shellOrigin: () => string): RequestHandler {
  return (req, res, next) => {
    const framePath = req.path.startsWith(FRAMES_PATH)
    if (!isFrameHost(req.headers.host)) {
      if (framePath) return void res.sendStatus(404)
      return next()
    }
    const [canvasRaw, frameRaw, extra] = framePath ? req.path.slice(FRAMES_PATH.length).split('/') : []
    const canvasId = asCanvasId(canvasRaw)
    const assetName = frameRaw === 'assets' ? asAssetName(extra) : null
    const image = req.method === 'GET' && canvasId && assetName ? read.asset(canvasId, assetName) : null
    if (image) {
      res.sendFile(image.path, {
        // The project's `.ezdesign/` is a dot directory.
        dotfiles: 'allow',
        headers: {
          'content-type': image.mime,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        },
      })
      return
    }
    const frameId = asFrameId(frameRaw)
    const doc = req.method === 'GET' && canvasId && frameId && extra === undefined ? read.frameDocument(canvasId, frameId) : null
    if (!doc) {
      res
        .status(404)
        .type('text/plain')
        .send(`Not a canvas frame. The review shell is at ${shellOrigin()}${URL_PREFIX}/shell`)
      return
    }
    res
      .type('html')
      .set({
        'cache-control': req.query.rev === doc.hash ? 'public, max-age=31536000, immutable' : 'no-store',
        'x-content-type-options': 'nosniff',
      })
      .send(doc.html)
  }
}
