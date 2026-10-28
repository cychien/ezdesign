---
name: ezdesign
description: Open an ezdesign review session on a running web page. The user annotates the page in the browser, and each batch reaches the coding agent with exact source locations. Use when the user invokes /ezdesign, or asks to review, annotate or give visual feedback on a running page, or to explore designs on a canvas.
metadata:
  version: 0.9.2
---

# ezdesign

Open a review: [reference/start.md](reference/start.md). A bare `/ezdesign`, with nothing after
it, is that request: open a review on the project's running dev server.

## Inside a review session

The daemon has done the routing: its prompt says whether the turn is a feedback batch or an
explore round, and what to do with it. Do not route again. A batch carries the page's `url`, the
annotated `items` with their `anchor` (source `file:line`, selector, viewport), `references`, and
`attachments`. A video attachment carries `video`: never open its `path`; read what `video.read`
says, which points you at contact sheets of its frames, each labelled with its time. An explore adds one element's capture - its markup, computed styles, slot and the
page's tokens - and takes each variant back through a tool, editing no file.

## Canvases

An ACP review session also gives you the `ezdesign-canvas` tools. Each turn's prompt says which tab
the user sent the batch from and which canvases exist.

- When the user wants to explore directions, compare options or see a design before it is built,
  put each one in a frame on a canvas: one `add_frame` per design, as soon as each is ready, on the
  canvas the turn's prompt names. Call `create_canvas` only when no canvas is open or the user asks
  for a new one. Leave `position` out; frames are placed for you.
- A frame is a complete HTML document with its own `<head>` and styles, at a real viewport width
  (390 phone, 768 tablet, 1280 desktop). Nothing is shared between frames.
- An item whose `anchor.frame` is set was made inside a frame: `anchor.source` is a line of that
  frame's file under `.ezdesign/canvases/`. Change a frame with `update_frame` (pass the
  `expectedHash` you last read) or by editing its file.
- Never edit `canvas.json` or `layout.json` by hand. Where a frame sits and its size are the user's.
