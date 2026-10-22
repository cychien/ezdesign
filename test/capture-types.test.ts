import { test } from 'node:test'
import type { Library, ReadyStage, ReceivingStage, TagName } from '../src/library/index.js'

export function stagesAreTypestate(receiving: ReceivingStage, ready: ReadyStage): void {
  // @ts-expect-error a stage still taking bytes has no commit
  receiving.commit({ tags: [], note: '' })
  if (ready.type === 'file') void ready.read(1024)
  // @ts-expect-error a link stage has no bytes to read
  else void ready.read(1024)
  if (ready.type === 'link') void ready.attachFrame(new Uint8Array())
  // @ts-expect-error only a link keeps a frame
  else void ready.attachFrame(new Uint8Array())
}

export function idsAndTagsAreBranded(library: Library, raw: string): void {
  // @ts-expect-error an arbitrary string is not an item id
  library.get(raw)
  // @ts-expect-error a tag name only comes out of normalizeTag
  const tag: TagName = raw
}

test('the capture types hold (checked by the typecheck, see this file)', () => {})
