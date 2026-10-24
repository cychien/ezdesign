/** Seen announcements live with the daemon rather than in the shell's storage:
 *  every session is its own origin, and a dismissal has to outlast all of them. */

import { Router } from 'express'
import type { AnnouncementsSeenWire } from './announcement-wire.js'
import { rememberAnnouncementSeen, seenAnnouncements } from './preferences.js'

export function announcementApiRouter(): Router {
  const router = Router()
  router.get('/announcements/seen', (_req, res) => {
    res.set('cache-control', 'no-store').json({ seen: seenAnnouncements() } satisfies AnnouncementsSeenWire)
  })
  router.post('/announcements/seen', (req, res) => {
    const id: unknown = (req.body as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string' || !id) return void res.status(400).json({ error: 'id required' })
    res.json({ seen: rememberAnnouncementSeen(id) } satisfies AnnouncementsSeenWire)
  })
  return router
}
