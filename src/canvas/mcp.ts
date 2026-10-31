/** The canvas tools the ACP agent manages canvases with, served over
 *  HTTP MCP on the session's own listener the way `explore_variant` is (see
 *  `mcp-explore.ts` for why ezdesign serves tools this way at all).
 *
 *  One server per session, for the session's whole life. A canvas outlives every
 *  turn and chat, and `mcpServers` is only read when an ACP session opens, so
 *  this server is in the list from the agent's first `session/new`, has one url
 *  and one bearer minted per runtime, and is never closed - not on turn end,
 *  chat switch, branch exit or agent switch. A server missing from the first
 *  list is silently missing for the whole conversation.
 *
 *  Auth: bearer, compared in constant time; a missing or foreign token gets the
 *  same 404 and JSON-RPC -32004 as the explore route, and no tool runs, so
 *  another session's token changes nothing on disk.
 *
 *  Nothing here waits for the user. Every tool returns as soon as the workspace
 *  has written; the shell learns of it from the workspace's change callback.
 *
 *  `CANVAS_TOOLS` is the one list: the registration, the zod schemas, the
 *  argument and result types, the permission predicate and the prompt's tool
 *  names all derive from it. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { URL_PREFIX } from '../constants.js'
import type { McpServerEntry } from '../mcp-explore.js'
import {
  CANVASES_DIR,
  type Canvas,
  type CanvasFrame,
  type CanvasId,
  type CanvasProblem,
  MAX_FRAME_HTML,
  type Outcome,
  type TabId,
} from './types.js'
import type { AgentCanvasPort } from './workspace.js'

export const CANVAS_SERVER_NAME = 'ezdesign-canvas'
/** Relative to the api router, mounted ahead of `MCP_ROUTE` (which would take
 *  `canvas` for an explore id) and ahead of the shared 2 MB JSON parser. */
export const CANVAS_MCP_ROUTE = '/mcp/canvas'
export const CANVAS_MCP_PATH = `${URL_PREFIX}/api${CANVAS_MCP_ROUTE}`
/** The largest legal frame, JSON-escaped, with room: an oversize document must
 *  reach the tool and come back as `HTML_TOO_LARGE`, not as the attachment
 *  handler's 413. */
export const CANVAS_MCP_BODY_LIMIT = MAX_FRAME_HTML * 6

interface ToolSpec<S extends z.ZodRawShape, R> {
  description: string
  input: S
  /** Writes nothing when it returns a problem. */
  run(port: AgentCanvasPort, args: z.infer<z.ZodObject<S>>): Outcome<R>
}

const tool = <S extends z.ZodRawShape, R>(spec: ToolSpec<S, R>): ToolSpec<S, R> => spec

const canvasId = z.string().describe('The canvas id, from create_canvas or list_canvases.')
const frameId = z.string().describe('The frame id, from add_frame or read_canvas.')
const px = (what: string) => z.number().int().optional().describe(what)

const dirOf = (id: CanvasId) => `${CANVASES_DIR}/${id}`

const listing = (f: CanvasFrame): FrameListing => ({
  frameId: f.id,
  title: f.title,
  file: f.file,
  hash: f.hash,
  ...f.rect,
})

const canvasRef = (c: Canvas) => ({ canvasId: c.id, name: c.name, dir: dirOf(c.id) })

const map = <T, R>(outcome: Outcome<T>, f: (value: T) => R): Outcome<R> =>
  outcome.ok ? { ok: true, value: f(outcome.value) } : outcome

export interface CanvasListing {
  canvasId: CanvasId
  name: string
  archived: boolean
  frames: number
  /** `${CANVASES_DIR}/<canvasId>`, for reading frame files directly. */
  dir: string
}

export interface FrameListing {
  frameId: string
  title: string
  file: string
  /** Pass back as `expectedHash` to `update_frame`. */
  hash: string
  x: number
  y: number
  width: number
  height: number
}

export const CANVAS_TOOLS = {
  list_canvases: tool({
    description:
      "List this project's canvases - open and archived - and which tab the user is looking at.",
    input: {},
    run: (port): Outcome<{ canvases: CanvasListing[]; activeTab: TabId | null }> => {
      const inventory = port.list()
      return {
        ok: true,
        value: {
          activeTab: inventory.activeTab,
          canvases: inventory.canvases.map((c) => ({
            canvasId: c.id,
            name: c.name,
            archived: c.archived,
            frames: c.frames,
            dir: dirOf(c.id),
          })),
        },
      }
    },
  }),
  create_canvas: tool({
    description:
      'Create an empty canvas and show it to the user as the active tab. Call it only when no canvas is open, the user asks for a new canvas, or the open one is full; otherwise add frames to an open canvas with add_frame.',
    input: {
      name: z
        .string()
        .describe("A short name for the canvas, in the user's language. Shown on its tab."),
    },
    run: (port, args): Outcome<{ canvasId: CanvasId; name: string; dir: string }> =>
      map(port.create(args.name), canvasRef),
  }),
  read_canvas: tool({
    description:
      "A canvas's frames: titles, sizes, positions, content hashes, and the project-relative file each frame's HTML lives in. Read a frame's HTML from its file.",
    input: { canvasId },
    run: (
      port,
      args,
    ): Outcome<{ canvasId: CanvasId; name: string; archived: boolean; frames: FrameListing[] }> =>
      map(port.read(args.canvasId), (c) => ({
        canvasId: c.id,
        name: c.name,
        archived: c.archivedAt !== undefined,
        frames: c.frames.map(listing),
      })),
  }),
  reopen_canvas: tool({
    description:
      'Reopen an archived canvas as a tab, and show it. A canvas must be open before any frame on it can change.',
    input: { canvasId },
    run: (port, args): Outcome<{ canvasId: CanvasId; name: string; dir: string }> =>
      map(port.reopen(args.canvasId), canvasRef),
  }),
  add_frame: tool({
    description: [
      'Add one frame to an open canvas: a complete, self-contained HTML document (<!doctype html>, its own <head> and styles) rendered in its own iframe at a real viewport width.',
      'Scripts and CDN assets are allowed. No CSS is shared between frames.',
      'width is the viewport width the page is designed for (390 phone, 768 tablet, 1280 desktop; default 1280); height defaults to a common screen for that width.',
      'Leave position out unless the user asked for a particular arrangement: the frame is then placed where it overlaps nothing, the frames of one turn side by side in the order you add them, in a row under the earlier ones. After creation a frame\'s position is the user\'s and its width is fixed; its height can follow its content through update_frame.',
      'Call once per frame, as soon as it is ready: the user watches frames appear.',
    ].join('\n'),
    input: {
      canvasId,
      title: z
        .string()
        .describe('A short label for this frame, in the user\'s language - "Hero A · 粗體標題".'),
      html: z.string().describe('The complete HTML document.'),
      width: px('Viewport width in CSS px (default 1280).'),
      height: px('Viewport height in CSS px (default: a common screen for the width).'),
      position: z
        .object({ x: z.number().int(), y: z.number().int() })
        .optional()
        .describe('Top-left on the canvas. Omit to have the frame placed for you.'),
    },
    run: (port, args): Outcome<FrameListing> =>
      map(
        port.addFrame({
          canvasId: args.canvasId,
          title: args.title,
          html: args.html,
          size: {
            ...(args.width !== undefined ? { width: args.width } : {}),
            ...(args.height !== undefined ? { height: args.height } : {}),
          },
          ...(args.position ? { position: args.position } : {}),
        }),
        listing,
      ),
  }),
  update_frame: tool({
    description: [
      "Replace a frame's HTML document, retitle it, and/or change its height.",
      'Pass expectedHash - the hash read_canvas, add_frame or your last update_frame returned - so an edit you have not seen is never overwritten: if the file changed since, nothing is written and the error names its current hash.',
      "For a small change you may instead edit the frame's file directly; the user's canvas updates either way.",
      'Pass height whenever the content needs a taller or shorter frame; frames below it move down to make room. Never remove a frame and add it again to resize it: that loses its place and the annotations made on it.',
      "A frame's position belongs to the user and its width is the viewport it was designed for; neither can be changed here.",
    ].join('\n'),
    input: {
      canvasId,
      frameId,
      html: z.string().optional().describe('The new complete HTML document.'),
      title: z.string().optional().describe('A new label for the frame.'),
      height: px('A new viewport height in CSS px, to fit the content.'),
      expectedHash: z
        .string()
        .optional()
        .describe('The hash of the version you are replacing.'),
    },
    run: (port, args): Outcome<FrameListing> =>
      map(
        port.updateFrame({
          canvasId: args.canvasId,
          frameId: args.frameId,
          ...(args.html !== undefined ? { html: args.html } : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.height !== undefined ? { height: args.height } : {}),
          ...(args.expectedHash !== undefined ? { expectedHash: args.expectedHash } : {}),
        }),
        listing,
      ),
  }),
  remove_frame: tool({
    description: 'Remove a frame from an open canvas. The user can undo this.',
    input: { canvasId, frameId },
    run: (port, args): Outcome<{ removed: string }> =>
      map(port.removeFrame(args.canvasId, args.frameId), (f) => ({ removed: f.id })),
  }),
} as const

type Tools = typeof CANVAS_TOOLS
export type CanvasToolName = keyof Tools
export type CanvasToolArgs<N extends CanvasToolName> = Parameters<Tools[N]['run']>[1]
export type CanvasToolResult<N extends CanvasToolName> =
  ReturnType<Tools[N]['run']> extends Outcome<infer R> ? R : never

export const CANVAS_TOOL_NAMES = Object.keys(CANVAS_TOOLS) as CanvasToolName[]

/** Claude Code's `mcp__<server>__<tool>` naming, the same evidence
 *  `isExploreTool` rests on; answered `allow_once`. An agent that names tools
 *  otherwise gets the conservative failure: the call becomes a user card. */
export function isCanvasTool(permissionName: string): boolean {
  const prefix = `mcp__${CANVAS_SERVER_NAME}__`
  return (
    permissionName.startsWith(prefix) &&
    (CANVAS_TOOL_NAMES as string[]).includes(permissionName.slice(prefix.length))
  )
}

/** One tool call against the agent's port, as MCP returns it. Exported so the
 *  refusals are tested without a transport. */
export function runCanvasTool<N extends CanvasToolName>(
  port: AgentCanvasPort,
  name: N,
  args: CanvasToolArgs<N>,
): { isError?: true; content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown> } {
  const run = CANVAS_TOOLS[name].run as (port: AgentCanvasPort, args: CanvasToolArgs<N>) => Outcome<unknown>
  const outcome = run(port, args)
  if (!outcome.ok) return { isError: true, content: [{ type: 'text', text: canvasProblemMessage(outcome.problem) }] }
  const value = outcome.value as Record<string, unknown>
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((req.get('authorization') ?? '').trim())
  return match ? match[1]! : null
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', id: null, error: { code, message } }
}

export class CanvasMcp {
  /** Minted once per runtime; a restarted daemon resumes the agent's session
   *  with the new one. */
  private readonly token = randomBytes(32).toString('base64url')

  constructor(private readonly port: AgentCanvasPort) {}

  /** The one `mcpServers` entry. `port` is asked for at session open, never
   *  held, like `ExploreMcp.serverEntries`: a restored session can move. */
  serverEntries(port: number): McpServerEntry[] {
    return [
      {
        type: 'http',
        name: CANVAS_SERVER_NAME,
        url: `http://127.0.0.1:${port}${CANVAS_MCP_PATH}`,
        headers: [{ name: 'authorization', value: `Bearer ${this.token}` }],
      },
    ]
  }

  private holds(req: Request): boolean {
    const given = Buffer.from(bearer(req) ?? '')
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  /** The bearer first, so a caller without it costs no parse; then its own
   *  body parser, whose overflow answers a JSON-RPC error naming the limit;
   *  then a fresh server and stateless transport per request, as
   *  `ExploreMcp.handler`. */
  handlers(): RequestHandler[] {
    const gate: RequestHandler = (req, res, next) => {
      if (this.holds(req)) return next()
      res.status(404).json(rpcError(-32004, 'no canvas tools here for this token'))
    }
    const tooLarge: ErrorRequestHandler = (err, _req, res, next) => {
      if ((err as { type?: string })?.type !== 'entity.too.large') return next(err)
      res.status(413).json(rpcError(-32600, `request is larger than ${CANVAS_MCP_BODY_LIMIT} bytes`))
    }
    const handle: RequestHandler = async (req: Request, res: Response) => {
      const server = new McpServer({ name: 'ezdesign-canvas', version: '1' }, { capabilities: { tools: {} } })
      for (const name of CANVAS_TOOL_NAMES) {
        const spec = CANVAS_TOOLS[name]
        server.registerTool(
          name,
          // Strict, so `x` or `width` on an existing frame is refused rather than
          // silently ignored: a frame's position is the user's, its width fixed.
          { description: spec.description, inputSchema: z.object(spec.input).strict() },
          (args: unknown) => runCanvasTool(this.port, name, args as never),
        )
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    }
    return [gate, express.json({ limit: CANVAS_MCP_BODY_LIMIT }), tooLarge as unknown as RequestHandler, handle]
  }
}

/** The refusal in the agent's words: its code first, then the call that would
 *  work. */
export function canvasProblemMessage(problem: CanvasProblem): string {
  switch (problem.code) {
    case 'CANVAS_NOT_FOUND':
      return `CANVAS_NOT_FOUND: no canvas has id ${JSON.stringify(problem.canvasId)}. Existing: ${
        problem.known.map((c) => `${c.id} (${c.name})`).join(', ') || 'none'
      }. Call list_canvases, or create_canvas to start one.`
    case 'CANVAS_ARCHIVED':
      return `CANVAS_ARCHIVED: canvas ${problem.canvasId} (${problem.name}) is archived. Call reopen_canvas first, then retry.`
    case 'FRAME_NOT_FOUND':
      return `FRAME_NOT_FOUND: canvas ${problem.canvasId} has no frame ${JSON.stringify(problem.frameId)}. Call read_canvas for its frames.`
    case 'FRAME_CONFLICT':
      return `FRAME_CONFLICT: frame ${problem.frameId} changed since you read it; its current hash is ${problem.currentHash}. Read its file again, then retry with expectedHash "${problem.currentHash}".`
    case 'HTML_EMPTY':
      return 'HTML_EMPTY: html is empty. Send a complete HTML document.'
    case 'HTML_TOO_LARGE':
      return `HTML_TOO_LARGE: html is ${problem.bytes} bytes; the limit is ${problem.limit}. Inline fewer assets, or split the design into several frames.`
    case 'NOT_A_DOCUMENT':
      return 'NOT_A_DOCUMENT: a frame is a whole page. Start with <!doctype html>, include <html>, a <head> with its own styles, and <body>.'
    case 'TOO_MANY_FRAMES':
      return `TOO_MANY_FRAMES: a canvas holds at most ${problem.limit} frames. Start another canvas with create_canvas.`
    case 'BAD_NAME':
      return `BAD_NAME: give a non-empty name of at most ${problem.max} characters.`
    case 'BAD_RECT':
      return `BAD_RECT: ${problem.reason}`
    case 'IMAGE_UNSUPPORTED':
    case 'IMAGE_TOO_LARGE':
    case 'IMAGE_EMPTY':
    case 'ASSET_NOT_FOUND':
      return `${problem.code}: only the user pastes images onto a canvas.`
  }
}
