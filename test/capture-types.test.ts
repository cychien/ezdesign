import { test } from 'node:test'
import type { AnsweredType, HostMessage, Request, RequestType, WireItem } from '../src/capture-wire.js'
import type { Item, Library, ReadyStage, ReceivingStage, TagName } from '../src/library/index.js'

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

export function wireShapesAreNotLibraryShapes(wire: WireItem): void {
  // @ts-expect-error the dialog's item is not the library's item
  const item: Item = wire
}

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const holds = <T extends true>(): T => true as T

type Surface = { [K in keyof Library]: Library[K] }[keyof Library]
type MentionsWire<T> = T extends (...args: infer A) => infer R
  ? Extract<A[number] | Awaited<R>, Request | HostMessage | WireItem> extends never
    ? false
    : true
  : false
holds<Equals<MentionsWire<Surface>, false>>()
holds<Equals<MentionsWire<(request: Request) => void>, true>>()

type Unanswered = Exclude<RequestType, AnsweredType>
holds<Equals<Unanswered, 'chunk' | 'cancel'>>()

test('the capture types hold (checked by the typecheck, see this file)', () => {})
