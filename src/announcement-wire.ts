/** The shell's end of release announcements. Types only, so the shell bundles it.
 *
 *      GET  /announcements/seen          -> AnnouncementsSeenWire
 *      POST /announcements/seen  { id }  -> AnnouncementsSeenWire */

export interface AnnouncementsSeenWire {
  seen: string[]
}
