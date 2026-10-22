import type { PageCommand, PageReplies } from '../shared/messages.js'
import { dismissDialog, presentDialog } from './dialog-host.js'
import { inspectMedia, readBytes } from './locate.js'

const INSTALLED = Symbol.for('ezdesign.capture.page-agent')

type Handlers = { [K in PageCommand['type']]: (command: Extract<PageCommand, { type: K }>) => Promise<PageReplies[K]> }

const handlers: Handlers = {
  inspect: (command) => inspectMedia(command.srcUrl, command.mediaType, command.fullFrame),
  read: async (command) => ({ data: await readBytes(command.url) }),
  present: (command) => presentDialog(command),
  dismiss: async (command) => {
    dismissDialog(command.captureId)
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
