import { toAgentItem } from '../../src/label.js'
import type { Annotation, Attachment } from '../../src/protocol.js'

/** Stands in for the session store: the label module only ever asks it where a
 *  file lives. */
export const FILES = {
  attachmentPath: (a: Attachment) => `/tmp/session/attachments/${a.id}-${a.name}`,
  sheetPath: (a: Attachment, sheet: number) => `/tmp/session/attachments/${a.id}.sheet-${sheet}.jpg`,
}

export const agentItem = (a: Annotation) => toAgentItem(a, FILES)
