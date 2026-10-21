# Canvas

Behind `EZDESIGN_CANVAS=1`, the review shell has a tab strip: an App tab while a dev server is attached, then one tab per open canvas. A canvas is a pan/zoom board of frames, each a complete HTML document from `<project>/.ezdesign/canvases/<canvasId>/frames/<frameId>.html`, served from `http://localhost:<session port>` (another site than the shell's `127.0.0.1`) with the overlay relayed through the shell, so element and region annotation work inside a frame and anchor to the frame file's `file:line`.

## Sub-features

- `canvas-empty-start` `ezdesign` with no url opens the shell on one `未命名 canvas`, created when the shell connects, with no App tab.
- `canvas-attach` `ezdesign <url>` in that project adds the App tab to the open shell and selects it, without a reload.
- `canvas-tabs` `新增 canvas`, double-click a tab to rename, `關閉 <name>` archives (an empty untitled canvas is deleted instead), `所有 canvas` lists every canvas with `重新開啟 <name>` and, for a closed one, `刪除 <name>` behind a `永久刪除「<name>」？` confirmation.
- `canvas-camera` drag the background or Space+drag to pan, wheel to pan, Cmd/Ctrl+wheel or a pinch to zoom around the cursor, `全部顯示` (⇧1), `放大`, `縮小`, `重設縮放` (⇧0); the zoom readout is `status "縮放比例"`. The camera is saved per canvas.
- `canvas-frames` frames are drawn at their real width; double-click one to scroll it or use its controls, Escape or a background click hands the pointer back.
- `canvas-annotate` `元素`/`範圍` work inside frames; the queue names the frame (`Hero A:14`), and the agent's label starts with `.ezdesign/canvases/<c>/frames/<f>.html:<line>` and ends with `[canvas frame "<title>" on canvas "<name>"]`.
- `canvas-isolation` a frame cannot act on the session api, read the shell's storage or DOM; its own `localStorage` works.

## How to get to it (user POV)

- `EZDESIGN_CANVAS=1 ezdesign [<url>] [--agent <name>]`, then the tab strip above the stage: `tab "App"`, `tab "<canvas name>"`, `button "新增 canvas"`, `button "所有 canvas"`.

## Driving it with chrome-devtools-axi and vz.mjs

Preconditions:

- Start the stack with the flag in the environment: `EZDESIGN_CANVAS=1 $V/vz.mjs up --dataset canvas` (or `seed canvas`, `seed canvas40`, `seed canvas-probe`, each also with the flag). Seeds write `fixtures/playground/.ezdesign/canvases/`; `down` removes it.
- `canvas` holds 首頁探索 (Hero A with `<h1>` on line 14 and three cards on lines 20-32, Hero B, Mobile) and 備用方向; `canvas40` holds 40 frames of 390×844 laid out 8×5 plus an empty canvas `空白`; `canvas-probe` holds one frame that probes its isolation and prints the result.

Recipes:

- **Board.** Click `tab "首頁探索"`; the snapshot has `region "canvas 首頁探索"` and `Iframe "Hero A · 1280×900"`. `eval "() => [...document.querySelectorAll('.ez-board:not([hidden]) iframe')].map(f => f.src)"` lists `http://localhost:<port>/__ezdesign/frames/...` urls.
- **Annotate in a frame.** Click `button "重設縮放"` first (see Gotchas), then `press e`, click `heading "大標題"`, fill the comment, `Meta+Enter`. `curl <session>/__ezdesign/api/state` shows the annotation with `anchor.frame` and `anchor.source` ending `:14`.
- **Isolation.** On `canvas-probe`, open `tab "isolation probe"`; the frame's text reads `origin http://localhost:<port>`, `parent.localStorage threw`, `parent.document.title threw`, `own localStorage ok`, `send blocked`, `acp/answer opaque`, and `/api/state` is unchanged.
- **Empty start.** From an empty directory with a `package.json`: `eval "$($V/vz.mjs env)"; EZDESIGN_CANVAS=1 node $PWD/dist/cli.mjs` there, then open the printed shell url. No `.ezdesign/` exists until the shell connects.
- **Perf.** On `canvas40`, time the `40 frames` tab click to every visible iframe's `load`, and record rAF deltas over a 5 s wheel pan and Ctrl+wheel zoom at fit-all.

## Gotchas

- chrome-devtools-axi clicks and drags at an element's unscaled position, so inside a board zoomed away from 100% a click lands on the wrong frame. Reset to 100% and pan the frame into view with a synthetic wheel (`eval` dispatching `WheelEvent` on `.ez-board:not([hidden])`), widening the window with `resize` when a frame is wider than the board.
- Requests a frame makes run in its own renderer process and do not appear in `chrome-devtools-axi network`; prove a refusal by the frame's own report and an unchanged `/api/state`.
- Boards stay mounted while hidden, so switching tabs never reloads a frame; only the first show of a canvas loads its iframes.
