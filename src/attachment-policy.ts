import { VIDEO_CAP_BYTES } from './library/policy.js'

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

export function isVideoMime(mime: string): boolean {
  return mime.startsWith('video/')
}

export function attachmentByteLimit(mime: string): number {
  return isVideoMime(mime) ? VIDEO_CAP_BYTES : MAX_ATTACHMENT_BYTES
}
