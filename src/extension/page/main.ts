import type { PageCommand, PageReplies } from '../shared/messages.js'
import { dismissDialog, presentDialog } from './dialog-host.js'
import { inspectMedia, readBytes } from './locate.js'
import { dropRecording, readRecording, recordVideo } from './record.js'
import { selectRegion } from './region.js'
import { clearSavedPill, showPill } from './saved-pill.js'

const INSTALLED = Symbol.for('ezdesign.capture.page-agent')

type Handlers = { [K in PageCommand['type']]: (command: Extract<PageCommand, { type: K }>) => Promise<PageReplies[K]> }

const handlers: Handlers = {
  // Both can be followed by a capture of the tab, which must not show the pill.
  'select-region': () => clearSavedPill().then(selectRegion),
  inspect: (command) => clearSavedPill().then(() => inspectMedia(command.srcUrl, command.mediaType, command.fullFrame)),
  read: async (command) => ({ data: await readBytes(command.url) }),
  present: (command) => presentDialog(command),
  dismiss: async (command) => {
    dismissDialog(command.captureId)
    return {}
  },
  pill: async (command) => {
    showPill(command.text, command.tone)
    return {}
  },
  record: (command) => recordVideo(command.captureId, command.srcUrl, command.maxSeconds),
  'recording-read': (command) => readRecording(command.captureId, command.offset, command.length),
  'recording-drop': async (command) => {
    dropRecording(command.captureId)
    return {}
  },
}

const scope = globalThis as Record<symbol, unknown>
if (!scope[INSTALLED]) {
  scope[INSTALLED] = true
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const command = message as PageCommand
    if (command?.to !== 'page' || sender.id !== chrome.runtime.id) return undefined
    const handle = handlers[command.type] as (c: PageCommand) => Promise<unknown>
    void handle(command).then(sendResponse, (error: unknown) => sendResponse({ error: String(error) }))
    return true
  })
}
