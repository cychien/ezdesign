import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Request, Router } from 'express'
import { APP_NAME, HOME_PATH, URL_PREFIX } from '../constants.js'
import { refuseCrossSite } from '../origin-gate.js'
import { versionGate } from '../version.js'
import type { HubRuntime, ProjectHub } from './hub.js'

export interface ProjectsRouterOptions {
  version: string
  origin(): string
  /** The project whose session mounts this router; absent on the home page. */
  current?: string
}

const field = (req: Request, name: string): unknown => (req.body as Record<string, unknown> | undefined)?.[name]

export function projectsApiRouter<R extends HubRuntime>(hub: ProjectHub<R>, opts: ProjectsRouterOptions): Router {
  const router = Router()
  const { current } = opts
  router.use('/projects', refuseCrossSite(opts.origin))

  // Before the version gate: an EventSource sends no header, so the page reads
  // the version off each event instead.
  router.get('/projects/events', (req, res) => {
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.flushHeaders()
    const push = () => res.write(`data: ${JSON.stringify(hub.list(current))}\n\n`)
    push()
    const unsubscribe = hub.subscribe(push)
    req.on('close', unsubscribe)
  })

  router.use('/projects', versionGate(opts.version))

  router.get('/projects', (_req, res) => {
    res.set('cache-control', 'no-store').json(hub.list(current))
  })

  router.post('/projects/open', async (req, res) => {
    const project = field(req, 'project')
    if (typeof project !== 'string') return void res.status(400).json({ error: 'project required' })
    const opened = await hub.open(project, field(req, 'host') === 'desktop' ? 'desktop' : 'browser')
    if ('ok' in opened) return void res.status(opened.status).json({ error: opened.error })
    res.json(opened)
  })

  router.post('/projects/stop', async (req, res) => {
    const project = field(req, 'project')
    if (typeof project !== 'string') return void res.status(400).json({ error: 'project required' })
    await hub.stop(project)
    res.json({ ok: true })
  })

  return router
}

/** Adding and hiding widen what the daemon will run, so only the home page's
 *  origin has them: a project's proxied app shares its session's origin. */
export function homeProjectsRouter<R extends HubRuntime>(hub: ProjectHub<R>, opts: Omit<ProjectsRouterOptions, 'current'>): Router {
  const router = Router()
  router.use('/projects', refuseCrossSite(opts.origin), versionGate(opts.version))
  router.post('/projects', (req, res) => {
    const path = field(req, 'path')
    if (typeof path !== 'string') return void res.status(400).json({ error: 'path required' })
    const added = hub.add(path.trim())
    if ('error' in added) return void res.status(400).json(added)
    res.json(added)
  })
  router.post('/projects/hide', (req, res) => {
    const project = field(req, 'project')
    if (typeof project !== 'string') return void res.status(400).json({ error: 'project required' })
    hub.hide(project)
    res.json({ ok: true })
  })
  return router
}

const homeHtml = (version: string, icon: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_NAME}</title>
<link rel="icon" href="${icon}">
<link rel="stylesheet" href="${URL_PREFIX}/home.css">
</head>
<body>
<div id="ez-home"></div>
<script src="${URL_PREFIX}/home.js" data-version="${version}"></script>
</body>
</html>`

export function homePageRouter(opts: { version: string; distDir: string; icon: string }): Router {
  const router = Router()
  router.get(HOME_PATH, (_req, res) => res.type('html').set('cache-control', 'no-store').send(homeHtml(opts.version, opts.icon)))
  for (const file of ['home.js', 'home.css']) {
    router.get(`${URL_PREFIX}/${file}`, (_req, res) => {
      res
        .type(file.endsWith('.css') ? 'text/css' : 'text/javascript')
        .set('cache-control', 'no-store')
        .send(readFileSync(join(opts.distDir, file)))
    })
  }
  return router
}
