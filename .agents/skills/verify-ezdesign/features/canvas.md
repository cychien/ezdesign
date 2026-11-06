# Canvas

The review shell has a tab strip: an App tab while a dev server is attached, then one tab per open canvas. A canvas is a pan/zoom board of frames, each a complete HTML document from `<project>/.ezdesign/canvases/<canvasId>/frames/<frameId>.html`, served from `http://localhost:<session port>` (another site than the shell's `127.0.0.1`) with the overlay relayed through the shell, so element and region annotation work inside a frame and anchor to the frame file's `file:line`.

## Sub-features

- `canvas-empty-start` `ezdesign` with no url opens the shell on one `未命名 canvas`, created when the shell connects, with no App tab.
- `canvas-attach` `ezdesign <url>` in that project adds the App tab to the open shell and selects it, without a reload.
- `canvas-tabs` `新增 canvas`, double-click a tab to rename, `關閉 <name>` archives (an empty untitled canvas is deleted instead), `Canvas` lists every canvas with `重新開啟 <name>` for a closed one and, on every row's hover, `刪除 <name>` behind a modal `永久刪除 "<name>"？` dialog (`取消` focused, Escape or a backdrop click cancels).
- `canvas-camera` Space+drag or a middle-button drag to pan, wheel to pan, Cmd/Ctrl+wheel or a pinch to zoom around the cursor, `縮小`, `放大`, ⇧1 fits all, ⇧0 resets to 100%; the zoom readout is `status "縮放比例"`. The camera is saved per canvas.
- `canvas-frames` frames are drawn at their real width; double-click one to scroll it or use its controls, Escape or a background click hands the pointer back.
- `canvas-annotate` `元素`/`範圍` work inside frames; the queue names the frame (`Hero A:14`), and the agent's label starts with `.ezdesign/canvases/<c>/frames/<f>.html:<line>` and ends with `[canvas frame "<title>" on canvas "<name>"]`.
- `canvas-annotate-frames` while `元素` or `範圍` is armed, a click on a frame's title opens a comment about that whole frame (popup at the frame's top-left, the frame outlined pink, queue `整個 <title>`, agent label `<frame file> · [whole canvas frame "<title>" on canvas "<name>"]`); a drag on the title still moves it. In `範圍`, a box drawn from the background, or from inside a frame out across others, comments on every frame it touches (queue `N 個 frame · A、B`, `anchor.frames`); a box that leaves its frame but touches no other stays that frame's region, clipped to it.
- `canvas-keys-ime` `E`, `R`, `N` and `1`-`4` work under Zhuyin or any IME (matched by physical key when the layout types no ASCII), from the shell and from inside a frame.
- `canvas-isolation` a frame cannot act on the session api, read the shell's storage or DOM; its own `localStorage` works.
- `canvas-edit` click, Shift+click, `⌘A` and a drag on the background (a box over every frame it touches, Shift adds) select; drag moves with guides; `⌘D`, `⌫`, arrows, `⌘Z`, `⌘⇧Z`; all of it persists in `layout.json`. A page has no resize handles; only the agent's `update_frame` changes its height.
- `canvas-image-resize` a pasted image lands at its natural size and aspect (down to 16 px, no letterbox). Selected alone, outside annotate mode, it shows eight handles (`.ez-board-handle[data-handle]`, corners as squares): a corner keeps the aspect and pins the opposite corner, an edge keeps the other axis centred, Alt resizes about the centre, and `.ez-board-size` reads `W × H` while dragging. One undo step; persists in `layout.json`. Handles hide under 24 px on screen. Double-click never makes an image live, and a wheel over a live page that cannot scroll pans the board.
- `canvas-agent` an ACP agent's `ezdesign-canvas` tools create canvases and frames live; editing a frame file updates the board.
- `canvas-cross-tab` `/element` started on one tab is answered on another, and the comment comes back on its own tab with the ref.

## How to get to it (user POV)

- `ezdesign [<url>] [--agent <name>]`, then the tab strip above the stage: `tab "App"`, `tab "<canvas name>"`, `button "新增 canvas"`, `button "Canvas"`.

## Driving it with chrome-devtools-axi and vz.mjs

Preconditions:

- Start the stack on a canvas dataset: `$V/vz.mjs up --dataset canvas` (or `seed canvas`, `seed canvas40`, `seed canvas-probe`). Seeds write `fixtures/playground/.ezdesign/canvases/`; `down` removes it.
- `canvas` holds 首頁探索 (Hero A with `<h1>` on line 14 and three cards on lines 20-32, Hero B, Mobile) and 備用方向; `canvas40` holds 40 frames of 390×844 laid out 8×5 plus an empty canvas `空白`; `canvas-probe` holds one frame that probes its isolation and prints the result.

Recipes:

- **Board.** Click `tab "首頁探索"`; the snapshot has `region "canvas 首頁探索"` and `Iframe "Hero A · 1280×900"`. `eval "() => [...document.querySelectorAll('.ez-board:not([hidden]) iframe')].map(f => f.src)"` lists `http://localhost:<port>/__ezdesign/frames/...` urls.
- **Annotate in a frame.** Click the board and `press Shift+0` first to reset to 100% (see Gotchas), then `press e`, click `heading "大標題"`, fill the comment, `Meta+Enter`. `curl <session>/__ezdesign/api/state` shows the annotation with `anchor.frame` and `anchor.source` ending `:14`.
- **Whole frames.** Drive it over CDP (`cdp.mjs`), since the box has to cross cross-origin frames: press `e`, click the `Hero A` title (`.ez-board-frame-head`), `Input.insertText`, `Meta+Enter`; press `r` and `drag` from inside Hero A to inside Hero B, then from the background below Hero B to Mobile. `/api/state` shows `anchor.frames` with one and two refs, and `poll` labels end `[whole canvas frame(s) ...]`. An IME key is `Input.dispatchKeyEvent` with `key: 'ㄍ', code: 'KeyE'`.
- **Image resize.** Over CDP: paste a generated PNG through the board's own `paste` listener (`new ClipboardEvent('paste', { clipboardData })` with a `File` in a `DataTransfer`), then drag a handle's centre by screen pixels (world × zoom) and read `GET /api/canvases/<id>` for the frame's `kind` and `rect`.
- **Isolation.** On `canvas-probe`, open `tab "isolation probe"`; the frame's text reads `origin http://localhost:<port>`, `parent.localStorage threw`, `parent.document.title threw`, `own localStorage ok`, `send blocked`, `acp/answer opaque`, and `/api/state` is unchanged.
- **Empty start.** From an empty directory with a `package.json`: `eval "$($V/vz.mjs env)"; node $PWD/dist/cli.mjs` there, then open the printed shell url. No `.ezdesign/` exists until the shell connects.
- **Cross-tab `/element`.** Run `$V/cross-tab.mjs "$($V/vz.mjs get shellUrl)" $E` with `poll` waiting in `fixtures/playground`. It comments on the App's hero with `/element` answered by Cmd+click in Hero A, then on Hero A with `/element` answered on the App, and sends. `log.txt` holds both annotations; the polled labels carry `[ref 1: .ezdesign/canvases/.../frames/...html:14 · ... [canvas frame "Hero A" on canvas "首頁探索"]]` and `[ref 1: src/sections/Nav.tsx:28 ...]`.
- **Perf.** On `canvas40`, time the `40 frames` tab click to every visible iframe's `load`, and record rAF deltas over a 5 s wheel pan and Ctrl+wheel zoom at fit-all.

## Gotchas

- chrome-devtools-axi clicks and drags at an element's unscaled position, so inside a board zoomed away from 100% a click lands on the wrong frame. Reset to 100% and pan the frame into view with a synthetic wheel (`eval` dispatching `WheelEvent` on `.ez-board:not([hidden])`), widening the window with `resize` when a frame is wider than the board.
- A pick inside a canvas frame needs Cmd held on a cross-origin document, which chrome-devtools-axi cannot do. `cross-tab.mjs` starts its own headless Chrome through `cdp.mjs` and sends CDP input instead.
- Requests a frame makes run in its own renderer process and do not appear in `chrome-devtools-axi network`; prove a refusal by the frame's own report and an unchanged `/api/state`.
- Boards stay mounted while hidden, so switching tabs never reloads a frame; only the first show of a canvas loads its iframes.
