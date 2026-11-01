import { type Request, Router } from 'express'
import type { DevServer, Initiator } from './index.js'

export function initiator(req: Request): Initiator {
  return (req.body as { host?: unknown } | undefined)?.host === 'desktop' ? 'desktop' : 'browser'
}

const field = (req: Request, name: string): unknown => (req.body as Record<string, unknown> | undefined)?.[name]

export function devServerApiRouter(devServer: DevServer): Router {
  const router = Router()

  router.get('/dev-server/log', (_req, res) => {
    res.set('cache-control', 'no-store').json(devServer.logWire())
  })

  router.post('/dev-server/start', (req, res) => {
    devServer.ensure(initiator(req))
    res.status(202).json({ ok: true })
  })

  router.post('/dev-server/restart', (req, res) => {
    devServer.restart(initiator(req))
    res.status(202).json({ ok: true })
  })

  router.post('/dev-server/stop', async (_req, res) => {
    if (devServer.external) return void res.status(409).json({ error: 'this dev server was not started here' })
    await devServer.stop()
    res.json({ ok: true })
  })

  router.post('/dev-server/command', (req, res) => {
    const line = field(req, 'line')
    const cwd = field(req, 'cwd') ?? ''
    if (typeof line !== 'string' || typeof cwd !== 'string') {
      return void res.status(400).json({ error: 'line and cwd must be strings' })
    }
    const outcome = devServer.saveCommandAndRun({ line, cwd }, initiator(req))
    if (outcome === 'invalid-line') return void res.status(400).json({ error: 'the command must be one line of 1-500 characters' })
    if (outcome === 'invalid-cwd') return void res.status(400).json({ error: 'the folder must be inside the project' })
    res.status(202).json({ ok: true })
  })

  router.delete('/dev-server/command', (_req, res) => {
    devServer.forgetCommand()
    res.json({ ok: true })
  })

  router.post('/dev-server/origin', (req, res) => {
    const origin = field(req, 'origin')
    if (typeof origin !== 'string' || !devServer.pickOrigin(origin)) {
      return void res.status(404).json({ error: 'not an origin this dev server printed' })
    }
    res.json({ ok: true })
  })

  return router
}
