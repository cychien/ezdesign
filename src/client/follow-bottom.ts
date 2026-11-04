/** A thread that follows its newest content while the reader is at the bottom,
 *  and holds their place once they scroll up to read - reporting instead that
 *  something arrived below, so they can come back down when they choose. */

export interface Scroller {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  addEventListener(
    type: 'scroll' | 'wheel' | 'touchstart' | 'keydown',
    listener: () => void,
    options?: { passive?: boolean },
  ): void
  scrollTo(options: { top: number; behavior?: 'auto' | 'smooth' }): void
}

/** Within this of the end still counts as at it: a reader who stopped a few
 *  pixels short meant the bottom, and subpixel heights never land on it exactly. */
const AT_BOTTOM_SLACK = 24

/** What a re-render brought. `follow` overrides a reader who scrolled away:
 *  their own message going out, or a different conversation coming in. Height
 *  alone cannot tell `arrived` from `same` - expanding an old batch grows it too. */
export type ThreadChange = 'same' | 'arrived' | 'follow'

export interface FollowBottom {
  /** Runs `paint`, which may replace everything inside the scroller, then either
   *  follows to the new bottom or puts the reader back where they were. */
  rerender(paint: () => void, change: ThreadChange): void
  /** The scroller's own box changed size; stay on the bottom if following. */
  resized(): void
  /** Back to the newest content, at the reader's request. */
  jump(smooth: boolean): void
  readonly unread: boolean
}

export function followBottom(scroller: Scroller, onUnread: (unread: boolean) => void): FollowBottom {
  let following = true
  // Set by `jump` until the animated scroll lands, so the frames on the way down
  // do not read as the reader having stopped short of the bottom.
  let chasing = false
  let unread = false

  const atBottom = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= AT_BOTTOM_SLACK
  const setUnread = (next: boolean) => {
    if (next === unread) return
    unread = next
    onUnread(next)
  }
  const pin = () => {
    scroller.scrollTop = scroller.scrollHeight
    following = true
    setUnread(false)
  }

  scroller.addEventListener(
    'scroll',
    () => {
      if (atBottom()) {
        chasing = false
        following = true
        setUnread(false)
      } else if (!chasing) {
        following = false
      }
    },
    { passive: true },
  )
  // Any hand on the scroller takes over from a jump still on its way down.
  const takeOver = () => {
    chasing = false
  }
  scroller.addEventListener('wheel', takeOver, { passive: true })
  scroller.addEventListener('touchstart', takeOver, { passive: true })
  scroller.addEventListener('keydown', takeOver)

  return {
    rerender(paint, change) {
      const top = scroller.scrollTop
      paint()
      if (change === 'follow' || following || chasing) {
        chasing = false
        pin()
        return
      }
      scroller.scrollTop = top
      if (change === 'arrived') setUnread(true)
    },
    resized() {
      if (following && !chasing) pin()
    },
    jump(smooth) {
      following = true
      setUnread(false)
      if (!smooth) {
        pin()
        return
      }
      chasing = true
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    },
    get unread() {
      return unread
    },
  }
}
