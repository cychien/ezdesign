import { createHash } from 'node:crypto'
import {
  type AnsweredRequest,
  type AnsweredType,
  HOST_CHUNK_BYTES,
  type HostMessage,
  PROTOCOL,
  type ReplyOf,
  type Request,
  type RequestType,
  type Staged,
  type WireError,
  type WireItem,
  negotiateProtocol,
  parseRequest,
} from '../capture-wire.js'
import {
  type Item,
  type Library,
  LibraryError,
  type ReadyLinkStage,
  type ReadyStage,
  type ReceivingStage,
} from '../library/index.js'
import type { downloadInto } from './download.js'
import type { downloadStream, probeSources } from './stream.js'

export interface HostSessionDeps {
  openLibrary(): Promise<Library>
  send(message: HostMessage): void
  drained(): Promise<void>
  download: typeof downloadInto
  downloadStream: typeof downloadStream
  probe: typeof probeSources
  hostVersion: string
  /** Best effort: a failure here must not refuse the extension. */
  greeted(extension: { version: string }): void
}

export interface HostSession {
  receive(raw: unknown): void
  close(): Promise<void>
  readonly ended: Promise<number>
}

const FRAME_MAX_BYTES = 64 * 1024 * 1024

interface Upload {
  size: number
  announced: number
  broken: WireError | null
  writing: Promise<void>
}

type CaptureEntry =
  | { state: 'downloading'; abort: AbortController }
  | ({ state: 'uploading'; stage: ReceivingStage } & Upload)
  | ({ state: 'framing'; stage: ReadyLinkStage; pieces: Buffer[] } & Upload)
  | { state: 'staged'; stage: ReadyStage }
  | { state: 'committed'; reply: ReplyOf<'commit'> }
  | { state: 'discarded' }

class Refusal extends Error {
  constructor(readonly error: WireError) {
    super(error.message)
  }
}

const refuse = (code: 'bad-request' | 'integrity' | 'unknown-capture' | 'cancelled' | 'internal', message: string) =>
  new Refusal({ code, message })

type Answer<K extends AnsweredType> = (request: Extract<Request, { t: K }>) => Promise<ReplyOf<K>>
type Handlers = { [K in AnsweredType]: Answer<K> } & {
  [K in Exclude<RequestType, AnsweredType>]: (request: Extract<Request, { t: K }>) => void
}

export function createHostSession(deps: HostSessionDeps): HostSession {
  const captures = new Map<string, CaptureEntry>()
  const inflight = new Map<number, AbortController>()
  let library: Library | null = null
  let greeted = false
  let closing: Promise<void> | null = null
  let end: (code: number) => void = () => {}
  const ended = new Promise<number>((resolve) => (end = resolve))

  const open = (): Library => {
    if (!library) throw refuse('bad-request', 'hello first')
    return library
  }

  const entry = (capture: string): CaptureEntry => {
    const found = captures.get(capture)
    if (!found) throw refuse('unknown-capture', `no capture ${capture} on this connection; stage it again`)
    return found
  }

  const claim = (capture: string): void => {
    if (captures.has(capture)) throw refuse('bad-request', `capture ${capture} is already in use`)
  }

  const staged = (capture: string): ReadyStage => {
    const found = entry(capture)
    if (found.state !== 'staged') throw refuse('bad-request', `capture ${capture} is ${found.state}, not staged`)
    return found.stage
  }

  const throwIfDiscarded = async (capture: string, stage: { discard(): Promise<void> }): Promise<void> => {
    if (captures.get(capture)?.state !== 'discarded') return
    await stage.discard()
    throw refuse('cancelled', `capture ${capture} was discarded`)
  }

  const finishUpload = async (
    capture: string,
    upload: CaptureEntry & { state: 'uploading' | 'framing' },
    sha256: string,
  ): Promise<Staged> => {
    await upload.writing
    const fail = upload.broken ?? (upload.announced !== upload.size ? integrity(`got ${upload.announced} of ${upload.size} bytes`) : null)
    if (upload.state === 'framing') {
      captures.set(capture, { state: 'staged', stage: upload.stage })
      if (fail) throw new Refusal(fail)
      const png = Buffer.concat(upload.pieces)
      const actual = createHash('sha256').update(png).digest('hex')
      if (actual !== sha256) throw new Refusal(integrity(`the frame hashes to ${actual}, not ${sha256}`))
      await upload.stage.attachFrame(png)
      return toStaged(upload.stage)
    }
    if (fail) {
      captures.set(capture, { state: 'discarded' })
      await upload.stage.discard()
      throw new Refusal(fail)
    }
    let ready: ReadyStage
    try {
      ready = await upload.stage.finish({ sha256 })
    } catch (error) {
      captures.set(capture, { state: 'discarded' })
      throw error
    }
    captures.set(capture, { state: 'staged', stage: ready })
    return toStaged(ready)
  }

  const handlers: Handlers = {
    async hello(request) {
      if (greeted) throw refuse('bad-request', 'hello was already received')
      const version = negotiateProtocol(PROTOCOL, request.protocol)
      if (version === null) {
        end(0)
        throw new Refusal({
          code: 'incompatible',
          message: `this host speaks protocol ${PROTOCOL.min}-${PROTOCOL.max}, the extension ${request.protocol.min}-${request.protocol.max}`,
          host: PROTOCOL,
        })
      }
      try {
        library = await deps.openLibrary()
      } catch (error) {
        end(0)
        throw error
      }
      greeted = true
      try {
        deps.greeted(request.extension)
      } catch {
        // Only the shell's install hint reads it.
      }
      return {
        protocol: version,
        host: { version: deps.hostVersion, node: process.version },
        library: { dir: library.dir },
      }
    },

    async download(request) {
      const lib = open()
      claim(request.capture)
      const abort = new AbortController()
      captures.set(request.capture, { state: 'downloading', abort })
      inflight.set(request.id, abort)
      try {
        const outcome = await (request.as === 'hls' ? deps.downloadStream : deps.download)(
          {
            url: request.url,
            referer: request.referer,
            userAgent: request.userAgent,
            signal: abort.signal,
            onProgress: (received, total) => deps.send({ t: 'progress', re: request.id, received, total }),
          },
          (expectedBytes) => lib.stage({ kind: request.kind, source: request.context, expectedBytes }),
        )
        switch (outcome.type) {
          case 'staged': {
            await throwIfDiscarded(request.capture, outcome.stage)
            let ready: ReadyStage
            try {
              ready = await outcome.stage.finish()
            } catch (error) {
              captures.set(request.capture, { state: 'discarded' })
              throw error
            }
            await throwIfDiscarded(request.capture, ready)
            captures.set(request.capture, { state: 'staged', stage: ready })
            return toStaged(ready)
          }
          case 'refused':
            captures.delete(request.capture)
            throw new Refusal({
              code: 'source-refused',
              message: `the source answered ${outcome.status}`,
              status: outcome.status,
            })
          case 'failed':
            captures.delete(request.capture)
            throw new Refusal({ code: 'source-failed', message: outcome.message, status: outcome.status })
          case 'cancelled':
            if (captures.get(request.capture)?.state === 'downloading') captures.delete(request.capture)
            throw refuse('cancelled', 'the download was cancelled')
        }
      } finally {
        inflight.delete(request.id)
      }
    },

    async upload(request) {
      const lib = open()
      if (request.kind === 'frame') {
        const target = staged(request.capture)
        if (target.type !== 'link') throw refuse('bad-request', 'only a link keeps a frame')
        if (request.size > FRAME_MAX_BYTES) throw refuse('bad-request', `a frame is at most ${FRAME_MAX_BYTES} bytes`)
        captures.set(request.capture, {
          state: 'framing',
          stage: target,
          pieces: [],
          size: request.size,
          announced: 0,
          broken: null,
          writing: Promise.resolve(),
        })
        return {}
      }
      claim(request.capture)
      captures.set(request.capture, {
        state: 'uploading',
        stage: lib.stage({ kind: request.kind, source: request.context, expectedBytes: request.size }),
        size: request.size,
        announced: 0,
        broken: null,
        writing: Promise.resolve(),
      })
      return {}
    },

    chunk(request) {
      const upload = captures.get(request.capture)
      if (upload?.state !== 'uploading' && upload?.state !== 'framing') return
      if (upload.broken) return
      if (request.offset !== upload.announced) {
        upload.broken = integrity(`a chunk at offset ${request.offset}, expected ${upload.announced}`)
        return
      }
      const bytes = Buffer.from(request.data, 'base64')
      upload.announced += bytes.length
      if (upload.announced > upload.size) {
        upload.broken = integrity(`more than the ${upload.size} bytes announced`)
        return
      }
      if (upload.state === 'framing') {
        upload.pieces.push(bytes)
        return
      }
      upload.writing = upload.writing.then(async () => {
        if (upload.broken) return
        try {
          await upload.stage.write(bytes)
        } catch (error) {
          upload.broken = toWireError(error)
        }
      })
    },

    async 'upload-end'(request) {
      open()
      const upload = entry(request.capture)
      if (upload.state !== 'uploading' && upload.state !== 'framing') {
        throw refuse('bad-request', `capture ${request.capture} is ${upload.state}, not uploading`)
      }
      return finishUpload(request.capture, upload, request.sha256)
    },

    async link(request) {
      const lib = open()
      claim(request.capture)
      const stage = lib.stageLink({ kind: 'video', source: request.context, playbackTime: request.playbackTime })
      captures.set(request.capture, { state: 'staged', stage })
      return toStaged(stage)
    },

    async thumbnail(request) {
      open()
      await staged(request.capture).setThumbnail({
        webp: Buffer.from(request.webp, 'base64'),
        width: request.width,
        height: request.height,
        source: request.source,
      })
      return {}
    },

    async read(request) {
      open()
      const stage = staged(request.capture)
      if (stage.type !== 'file') throw refuse('bad-request', 'a link has no bytes to read')
      const abort = new AbortController()
      inflight.set(request.id, abort)
      try {
        let seq = 0
        let bytes = 0
        for await (const piece of stage.read(HOST_CHUNK_BYTES)) {
          if (abort.signal.aborted) throw refuse('cancelled', 'the read was cancelled')
          deps.send({ t: 'bytes', re: request.id, seq: seq++, data: Buffer.from(piece).toString('base64') })
          bytes += piece.length
          await deps.drained()
        }
        return { bytes }
      } finally {
        inflight.delete(request.id)
      }
    },

    async commit(request) {
      open()
      const found = entry(request.capture)
      if (found.state === 'committed') return found.reply
      if (found.state !== 'staged') throw refuse('bad-request', `capture ${request.capture} is ${found.state}, not staged`)
      const result = await found.stage.commit({ tags: request.tags, note: request.note })
      const reply = { item: toWireItem(result.item), merged: result.merged }
      captures.set(request.capture, { state: 'committed', reply })
      return reply
    },

    async discard(request) {
      open()
      const found = captures.get(request.capture)
      if (!found || found.state === 'committed' || found.state === 'discarded') return {}
      captures.set(request.capture, { state: 'discarded' })
      if (found.state === 'downloading') found.abort.abort()
      else await found.stage.discard()
      return {}
    },

    async suggest(request) {
      return { tags: open().suggestTags(request.prefix, { exclude: request.exclude, limit: request.limit }) }
    },

    async probe(request) {
      open()
      return deps.probe(request.sources, request)
    },

    cancel(request) {
      inflight.get(request.ref)?.abort()
    },
  }

  const answer = (request: AnsweredRequest): void => {
    const handler = handlers[request.t] as (request: AnsweredRequest) => Promise<unknown>
    handler(request).then(
      (value) => deps.send({ t: 'result', re: request.id, value }),
      (error: unknown) => deps.send({ t: 'error', re: request.id, error: toWireError(error) }),
    )
  }

  return {
    receive(raw) {
      if (closing) return
      const parsed = parseRequest(raw)
      if (!parsed.ok) {
        const id = (raw as { id?: unknown } | null)?.id
        if (typeof id === 'number' && Number.isInteger(id) && id >= 0) {
          deps.send({ t: 'error', re: id, error: parsed.error })
        } else {
          deps.send({ t: 'fatal', error: parsed.error })
          end(1)
        }
        return
      }
      const request = parsed.request
      if (request.t === 'chunk') return handlers.chunk(request)
      if (request.t === 'cancel') return handlers.cancel(request)
      if (!greeted && request.t !== 'hello') {
        deps.send({ t: 'error', re: request.id, error: { code: 'bad-request', message: 'hello first' } })
        return
      }
      answer(request)
    },

    close() {
      closing ??= (async () => {
        for (const abort of inflight.values()) abort.abort()
        for (const [capture, found] of captures) {
          captures.set(capture, { state: 'discarded' })
          if (found.state === 'downloading') found.abort.abort()
          else if (found.state === 'uploading' || found.state === 'framing' || found.state === 'staged') {
            await found.stage.discard().catch(() => {})
          }
        }
        library?.close()
      })()
      return closing
    },

    ended,
  }
}

function integrity(message: string): WireError {
  return { code: 'integrity', message }
}

function toWireItem(item: Item): WireItem {
  return { id: item.id, tags: [...item.tags], note: item.note, hasThumbnail: item.thumbnail !== null }
}

function toStaged(stage: ReadyStage): Staged {
  if (stage.type === 'file') {
    return {
      outcome: 'file',
      bytes: stage.file.bytes,
      mediaType: stage.file.mediaType,
      duplicate: stage.duplicateOf && toWireItem(stage.duplicateOf),
    }
  }
  return {
    outcome: stage.link.reason === 'stream' ? 'stream-link' : 'too-large',
    bytes: stage.link.bytes,
    mediaType: null,
    duplicate: null,
  }
}

function toWireError(error: unknown): WireError {
  if (error instanceof Refusal) return error.error
  if (error instanceof LibraryError) {
    if (error.code === 'integrity') return integrity(error.message)
    if (error.code === 'unsupported-media') return { code: 'source-failed', message: error.message, status: null }
    return { code: 'library', message: error.message, retryable: error.retryable }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}
