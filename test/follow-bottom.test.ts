import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Scroller, followBottom } from '../src/client/follow-bottom.js'

/** A scroller with the browser's clamping, whose scroll events the test fires by hand. */
function fakeScroller(clientHeight = 100) {
  let top = 0
  const listeners = new Map<string, (() => void)[]>()
  const el = {
    content: 300,
    clientHeight,
    get scrollHeight() {
      return Math.max(el.content, el.clientHeight)
    },
    get scrollTop() {
      return top
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight))
    },
    addEventListener(type: string, fn: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    scrollTo({ top: to }: { top: number }) {
      el.scrollTop = to
    },
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    /** The reader scrolling there. */
    readTo(v: number) {
      el.scrollTop = v
      el.fire('scroll')
    },
  }
  return el satisfies Scroller & Record<string, unknown>
}

function setup() {
  const el = fakeScroller()
  const unread: boolean[] = []
  const follow = followBottom(el, (u) => unread.push(u))
  const grow = (by: number) => () => {
    el.content += by
  }
  return { el, follow, unread, grow }
}

test('a reader at the bottom follows whatever arrives', () => {
  const { el, follow, unread, grow } = setup()
  follow.rerender(grow(0), 'follow')
  assert.equal(el.scrollTop, 200)
  follow.rerender(grow(50), 'arrived')
  assert.equal(el.scrollTop, 250)
  assert.deepEqual(unread, [])
})

test('a reader who scrolled up keeps their place and is told something arrived', () => {
  const { el, follow, unread, grow } = setup()
  follow.rerender(grow(0), 'follow')
  el.readTo(40)
  follow.rerender(grow(80), 'arrived')
  assert.equal(el.scrollTop, 40)
  assert.equal(follow.unread, true)
  assert.deepEqual(unread, [true])
})

test('a re-render that brought nothing new holds the place without claiming news', () => {
  const { el, follow, grow } = setup()
  follow.rerender(grow(0), 'follow')
  el.readTo(40)
  follow.rerender(grow(120), 'same')
  assert.equal(el.scrollTop, 40)
  assert.equal(follow.unread, false)
})

test("the reader's own message pulls them down from wherever they were", () => {
  const { el, follow, grow } = setup()
  follow.rerender(grow(0), 'follow')
  el.readTo(40)
  follow.rerender(grow(80), 'arrived')
  follow.rerender(grow(30), 'follow')
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight)
  assert.equal(follow.unread, false)
})

test('reaching the bottom by hand clears the notice and resumes following', () => {
  const { el, follow, unread, grow } = setup()
  follow.rerender(grow(0), 'follow')
  el.readTo(40)
  follow.rerender(grow(80), 'arrived')
  el.readTo(el.scrollHeight - el.clientHeight - 10)
  assert.deepEqual(unread, [true, false])
  follow.rerender(grow(60), 'arrived')
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight)
})

test('jumping down follows again, and a re-render mid-scroll still lands on the bottom', () => {
  const { el, follow, grow } = setup()
  follow.rerender(grow(0), 'follow')
  el.readTo(40)
  follow.rerender(grow(80), 'arrived')
  follow.jump(true)
  assert.equal(follow.unread, false)
  // A frame of the animation, still short of the end.
  el.readTo(120)
  follow.rerender(grow(40), 'arrived')
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight)
  assert.equal(follow.unread, false)
})

test('a wheel during the jump hands the scroll back to the reader', () => {
  const { el, follow, grow } = setup()
  follow.rerender(grow(0), 'follow')
  el.readTo(40)
  follow.jump(true)
  el.fire('wheel')
  el.readTo(30)
  follow.rerender(grow(40), 'arrived')
  assert.equal(el.scrollTop, 30)
  assert.equal(follow.unread, true)
})

test('a resize keeps a following reader on the bottom and leaves a reading one alone', () => {
  const { el, follow, grow } = setup()
  follow.rerender(grow(0), 'follow')
  el.clientHeight = 60
  follow.resized()
  assert.equal(el.scrollTop, 240)
  el.readTo(10)
  el.clientHeight = 80
  follow.resized()
  assert.equal(el.scrollTop, 10)
})
