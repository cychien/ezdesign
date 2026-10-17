# Consumer install

What a user gets from npm: the packed tarball installs into a fresh project, its `ezdesign` bin runs and serves a working shell from the installed `dist/`, and `import { ezdesignSource } from 'ezdesign/vite'` gives a dev-only plugin that stamps `data-ez-source="file:line"`.

## Sub-features

- `pack-contents` the tarball has `dist/cli.mjs`, `dist/vite.mjs`, `dist/vite.d.ts`, shell and overlay assets, `skills/ezdesign/` (SKILL.md, reference/, scripts/), README, LICENSE, and no `src/ test/ fixtures/ scripts/`.
- `pack-bin` the installed bin answers `--version`, `--help`, `status`, and rejects a bad control port.
- `pack-vite` `ezdesign/vite` imports without `vite` installed and its transform stamps `A.tsx:1`.
- `pack-daemon` the installed bin opens a session on a live dev server and its daemon serves `/__ezdesign/shell` and `shell.js`.
- `pack-isolation` with `HOME` and `EZDESIGN_DATA_DIR` isolated, nothing is written to `$HOME/.ezdesign`.

## How to get to it (user POV)

- `npx -y ezdesign@latest <url>` (here: the local tarball instead of the registry).
- `import { ezdesignSource } from 'ezdesign/vite'` in `vite.config.ts`.

## Driving it with chrome-devtools-axi and vz.mjs

Preconditions:

- A stack is up (`$V/vz.mjs up`) so the session step has a dev server to proxy; without one that step is skipped and says so.
- Network access to the npm registry (the install resolves the tarball's dependencies; the user's npm cache is reused).

- **Run the recipe.** Run `$V/vz.mjs consumer`. Every line is `ok`, exit 0, ~15 s.
- **Contents.** `<evidence>/consumer/tarball-files.txt` lists 25 files for 0.7.0 including `dist/constants.d.ts` and `dist/project-root.d.ts` (types `vite.d.ts` imports).
- **Transcript.** `<evidence>/consumer/transcript.txt` holds each command with stdout, stderr and exit, the transformed JSX (`<div data-ez-source="A.tsx:1">hi</div>`), the shell GET status and `shell.js` size, and `# isolated HOME has .ezdesign: false`.

## Gotchas

- `npm pack` does not build (only `prepublishOnly` does); the recipe runs `npm run build` first. Packing by hand without it ships whatever stale `dist/` is on disk.
- The recipe rebuilds `dist/` under a running stack; restart the stack (`down`/`up`) before proving daemon changes afterwards.
- The installed daemon uses its own data dir and control range from 4900; the recipe stops it in a `finally` and then reaps its pid (only while its command line is under the recipe's temp dir). Only a hard kill of `vz.mjs` itself can strand it: find it with `ps -o pid,command | grep ezdesign-verify` and kill that pid.
- This proves the local tarball, not the published `ezdesign@latest`.
