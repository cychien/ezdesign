import type { MediaReplies, MediaRequest } from '../shared/messages.js'
import { type MediaClient, THUMBNAIL_SOURCE_MAX_BYTES } from './ports.js'

export const MEDIA_DOCUMENT = 'media.html'

export function createMediaClient(documentPath: string): MediaClient {
  let warming: Promise<void> | null = null
  const url = chrome.runtime.getURL(documentPath)

  const warm = (): Promise<void> => {
    warming ??= (async () => {
      const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })
      if (open.length === 0) {
        await chrome.offscreen.createDocument({
          url,
          reasons: ['BLOBS'],
          justification: 'Decode saved images and screenshots to make their thumbnails',
        })
      }
    })().catch((error: unknown) => {
      warming = null
      throw error
    })
    return warming
  }

  const call = async <K extends MediaRequest['type']>(
    request: Extract<MediaRequest, { type: K }>,
  ): Promise<MediaReplies[K]> => {
    await warm()
    return chrome.runtime.sendMessage<MediaReplies[K]>(request)
  }

  return {
    warm,
    async thumbnail(pieces, at) {
      const job = crypto.randomUUID()
      let fed = 0
      try {
        for await (const data of pieces) {
          fed += (data.length * 3) / 4
          if (fed > THUMBNAIL_SOURCE_MAX_BYTES) return null
          await call({ to: 'media', type: 'feed', job, data })
        }
        return (await call({ to: 'media', type: 'thumbnail', job, at: at ?? null })).thumb
      } finally {
        void call({ to: 'media', type: 'drop', job }).catch(() => {})
      }
    },
    crop(screenshot, rect, viewport, original) {
      return call({ to: 'media', type: 'crop', job: crypto.randomUUID(), screenshot, rect, viewport, original })
    },
  }
}
