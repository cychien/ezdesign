# Device previews

The shell previews the live page at real device viewports: one size at a time (手機 375, 平板 1112, 電腦 = the stage's own size), or all of them side by side on a draggable grid at true size, and every preview stays a live, annotatable page.

## Sub-features

- `device-single` keys `1` `2` `3` resize the single preview in place to 375 / 1112 / stage width.
- `device-menu` `換一個尺寸` opens a menu of the sizes.
- `device-grid` key `4` or `全部尺寸` lays 手機 375×629, 平板 1112×740 and 電腦 1440×788 out as separate frames.
- `device-grid-sizes` the stage-corner control picks which sizes are on the grid (portrait tablet 834×1018 is off by default).
- `device-anchor` an annotation made in a preview carries that preview's `viewport` and `preset`.

## How to get to it (user POV)

- Press `1`, `2`, `3` or `4` while focus is outside a text field.
- Choose `button "電腦"` (current size), `button "換一個尺寸"` (menu), `button "全部尺寸"` (grid).
- On the grid, choose `button "選擇畫布上要顯示的尺寸"`.

## Driving it with chrome-devtools-axi and vz.mjs

Preconditions:

- `baseline`, shell open, no text field focused (`npx -y chrome-devtools-axi press Escape`).
- `E=$($V/vz.mjs get evidenceDir)/device-previews; mkdir -p $E`.

- **Phone.** Run `npx -y chrome-devtools-axi press 1`. `eval "() => [...document.querySelectorAll('iframe')].map(f => f.contentWindow.innerWidth)"` returns `[375]`; the size button reads `手機`; the frame height is the stage's (about 2000 in a headless window), not 629.
- **Tablet.** Run `npx -y chrome-devtools-axi press 2`. The same eval returns `[1112]`; `button "平板" description="平板 · 1112×740（1 / 2 / 3）"`.
- **Grid.** Run `npx -y chrome-devtools-axi press 4`. The snapshot has three `Iframe` nodes named `手機 · 375×629`, `平板 · 1112×740`, `電腦 · 1440×788`; `eval "() => [...document.querySelectorAll('iframe')].map(f => f.title + ' ' + f.contentWindow.innerWidth + 'x' + f.contentWindow.innerHeight)"` returns exactly those sizes. Screenshot `$E/grid.png`.
- **Annotate on a card.** Press `e`, click an element inside the `Iframe "手機 · 375×629"`, queue it. `queue.json`'s anchor has `viewport.width` `375` and `preset` `mobile`.
- **Back to one.** Press `Escape` twice (comment box, then mode) and `npx -y chrome-devtools-axi press 3`. One frame again, at the stage width (856 in a 1200px window).

## Gotchas

- Known defect: switching size in single view resizes the existing frame but never updates its `title`, so `Iframe "電腦 · 1440×788"` stays named 電腦 while showing 375 px (and after `4` then `2` it stays `手機 · 375×629` while 1112 wide). Assert on `contentWindow.innerWidth` and the size button, not the iframe name. (`setDevice` in `src/client/shell.ts` calls `paintFrames()` without touching `iframe.title`, which `mountFrame` sets once.)
- The grid is drawn at true size and does not fit a 1200px headless window; parts are off-screen until the background is dragged. Screenshots show only what is in view.
- The chosen size is remembered per browser profile; a fresh axi session starts on 電腦.
- On the grid every frame holds the same page, so a heading appears three times in the snapshot; the first match is the 手機 card's (frames are listed 手機, 平板, 電腦).
