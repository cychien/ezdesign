# Brand

`src/brand.ts` is the only place the mark and the wordmark are drawn. Every surface takes them
from there, inline or as a copy generated from it; nothing redraws them by hand.

## The parts

- **Mark.** A speech-bubble pin with a white dot: the annotation pin the overlay drops on the page,
  turned into a sign. Filled with the sunset gradient (`BRAND_SUNSET`), whose middle stop is
  `--mark` (`#e56d41`), so at icon size it still reads as the annotation orange. The dot stays
  white on every ground.
- **Wordmark.** "ezdesign" in Geist at weight 550, -0.05em tracking, outlined to a path so no
  surface has to load the font. 550 sits between Medium, too light beside the shell's 11px UI
  text, and SemiBold, too heavy. One colour, the ink of the ground it sits on: `--ink` in the
  shell, `#171717` / `#f0f6fc` in the README.
- **Lockup.** Mark and wordmark side by side (`LOCKUP`): a 16-unit mark, a 5-unit gap, a 13-unit
  wordmark whose ascender-to-baseline span is centred on the mark; centring the whole ink box,
  the g's descender included, sat the mark visibly low. Scale it as one piece; never re-space it.

The mark goes alone where there is no room for words (favicon, toolbar). Never recolour it, put it
in a container shape, or set the wordmark in live text in its place.

## Where it appears

| Surface | Form | How it gets there |
| --- | --- | --- |
| Review shell header | Lockup, `currentColor` | `brandLockupSvg()`, inline |
| Shell tab icon | Mark | `brandMarkSvg()` as a `data:` URL in `src/daemon.ts` |
| Capture extension | Mark, PNG at 16, 32, 48, 128 | `src/extension/icons/`, generated |
| README | Lockup, light and dark | `docs/brand/`, generated |

## Generated copies

The wordmark's outline lives in `src/brand-wordmark.ts`, generated from the font named in
`scripts/brand-wordmark.mjs` (`WORDMARK`: weight, tracking, text); change it there, never by hand.
GitHub cannot inline an SVG from TypeScript and Chrome wants PNG for extension icons, so those
copies are files checked into the repo too. After changing either source, regenerate everything:

```
npm run brand
```

It outlines the wordmark, writes the README lockups as SVG and renders the extension icons
through headless Chrome (`CHROME_PATH` if Chrome is not in its usual place). The 128 icon draws the mark at 96 inside
16 of padding, as Chrome's store guidelines ask; the smaller ones fill their square.

`test/brand.test.ts` fails when a copy no longer matches its source: the wordmark module and the
SVGs are compared byte for byte, and each PNG carries a hash of the page it was rendered from in a `tEXt` chunk.
