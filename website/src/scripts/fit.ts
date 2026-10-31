/** Scales each `[data-fit="<width>"]` frame's fixed-size stage to the frame's width, through `--fit`. */
export function fitStages(): void {
  for (const frame of document.querySelectorAll<HTMLElement>('[data-fit]')) {
    const width = Number(frame.dataset.fit)
    const update = () => frame.style.setProperty('--fit', String(frame.clientWidth / width))
    new ResizeObserver(update).observe(frame)
    update()
  }
}
