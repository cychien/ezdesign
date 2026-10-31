type Point = { x: number; y: number }
type Step = { ms: number; run?: () => void }

const STAGE_WIDTH = 1440
const REST: Point = { x: 900, y: 620 }
const WATCH: Point = { x: 1190, y: 430 }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Plays the review loop on a static copy of the shell: pick the trial button,
 *  write a comment, queue it, send it, and watch the agent change the page. */
export function runDemo(stage: HTMLElement, progress: HTMLElement, replay: HTMLButtonElement): void {
  const q = <T extends HTMLElement>(selector: string) => stage.querySelector<T>(selector)!
  const target = (name: string) => q(`[data-target="${name}"]`)
  const cursor = q('[data-cursor]')
  const hl = q('[data-hl]')
  const badge = q('[data-badge]')
  const pin = q('[data-pin]')
  const popup = q('[data-popup]')
  const typed = q('[data-typed]')
  const status = q('[data-status]')
  const activity = q('[data-activity]')
  const comment = stage.dataset.comment!

  const flags = ['mode', 'hover', 'selected', 'popupOpen', 'typing', 'queued', 'sent', 'working', 'applied'] as const
  const set = (flag: (typeof flags)[number], on: boolean | string) => {
    if (on === false) delete stage.dataset[flag]
    else stage.dataset[flag] = on === true ? '' : on
  }

  const scale = () => stage.getBoundingClientRect().width / STAGE_WIDTH
  const box = (el: HTMLElement) => {
    const s = stage.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const k = scale()
    return { x: (r.left - s.left) / k, y: (r.top - s.top) / k, w: r.width / k, h: r.height / k }
  }
  const place = (el: HTMLElement, p: Point) => {
    el.style.transform = `translate(${p.x}px, ${p.y}px)`
  }

  const frame = (el: HTMLElement) => {
    const b = box(el)
    const pad = 3
    hl.style.width = `${b.w + pad * 2}px`
    hl.style.height = `${b.h + pad * 2}px`
    place(hl, { x: b.x - pad, y: b.y - pad })
    place(badge, { x: b.x - pad, y: b.y - pad - 26 })
    place(pin, { x: b.x - 10, y: b.y - 10 })
    place(popup, { x: b.x, y: b.y + b.h + 12 })
  }

  const reset = () => {
    for (const flag of flags) set(flag, false)
    typed.textContent = ''
    status.textContent = 'Agent connected'
    activity.textContent = ''
    cursor.style.transition = 'none'
    place(cursor, REST)
    progress.style.transition = 'none'
    progress.style.transform = 'scaleX(0)'
    void progress.offsetWidth
  }

  const wait = (ms: number, run?: () => void): Step => ({ ms, run })
  const glide = (ms: number, to: () => Point): Step => ({
    ms: ms + 60,
    run: () => {
      cursor.style.transition = `transform ${ms}ms cubic-bezier(.45,0,.2,1)`
      place(cursor, to())
    },
  })
  const glideTo = (ms: number, name: string, dx = 0.5, dy = 0.55) =>
    glide(ms, () => {
      const b = box(target(name))
      return { x: b.x + b.w * dx, y: b.y + b.h * dy }
    })
  const press = wait(110, () => {
    cursor.classList.remove('press')
    void cursor.offsetWidth
    cursor.classList.add('press')
  })
  const type = (text: string) =>
    [...text].map((char, i) =>
      wait(char === ' ' ? 55 : 32, () => {
        set('typing', true)
        typed.textContent = text.slice(0, i + 1)
      }),
    )

  const timeline: Step[] = [
    wait(1100, reset),
    glideTo(500, 'element'),
    press,
    wait(500, () => {
      set('mode', 'element')
      frame(target('trial'))
    }),
    glideTo(900, 'trial', 0.4, 0.6),
    wait(650, () => set('hover', true)),
    press,
    wait(450, () => {
      set('selected', true)
      set('popupOpen', true)
    }),
    ...type(comment),
    wait(700),
    glideTo(380, 'add'),
    press,
    wait(900, () => {
      set('popupOpen', false)
      set('selected', false)
      set('hover', false)
      set('mode', false)
      set('queued', true)
    }),
    glideTo(900, 'send', 0.62),
    press,
    wait(1000, () => {
      set('queued', false)
      set('sent', true)
      set('working', true)
      status.textContent = 'Agent working'
      activity.textContent = 'Reading src/sections/Hero.tsx…'
    }),
    wait(1300, () => {
      activity.textContent = 'Editing src/styles.css…'
    }),
    wait(0, () => {
      set('working', false)
      set('applied', true)
      status.textContent = 'Agent connected'
    }),
    glide(380, () => WATCH),
    wait(3600),
  ]
  const total = timeline.reduce((sum, step) => sum + step.ms, 0)

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    reset()
    set('sent', true)
    set('applied', true)
    place(cursor, WATCH)
    return
  }

  let visible = false
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
  }).observe(stage)

  let generation = 0
  const play = async (run: number) => {
    let elapsed = 0
    for (const step of timeline) {
      while (!visible || document.hidden) await sleep(250)
      if (run !== generation) return
      step.run?.()
      elapsed += step.ms
      progress.style.transition = `transform ${step.ms}ms linear`
      progress.style.transform = `scaleX(${elapsed / total})`
      await sleep(step.ms)
      if (run !== generation) return
    }
  }
  const start = async () => {
    const run = ++generation
    while (run === generation) await play(run)
  }

  replay.addEventListener('click', () => void start())
  void document.fonts.ready.then(start)
}
