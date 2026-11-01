<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/ezdesign-dark.svg">
    <img alt="ezdesign" src="docs/brand/ezdesign-light.svg" height="32">
  </picture>
</h1>

**The best way to design with AI agents.** Click anything in your running app, say what should
change, and your coding agent edits the exact line of code.

[![npm](https://img.shields.io/npm/v/@cychien/ezdesign?color=e56d41&label=npm)](https://www.npmjs.com/package/@cychien/ezdesign)
[![license](https://img.shields.io/badge/license-MIT-171717)](#license)

```sh
npx -y @cychien/ezdesign@latest http://localhost:5173 --agent claude
```

Works with **Claude Code**, **Codex** and **Gemini CLI**. Open source, runs on your machine, no API
key. See it in action at **[ezdesign.dev](https://ezdesign.dev)**.

## Why

Describing UI changes in chat is lossy. "Make the second card's title a bit bigger" leaves your
agent guessing which card, which file and how much. Designing in Figma first means building
everything twice.

ezdesign puts the review on the real page. You point, it tells the agent where that thing lives in
your source, and the change appears in place a moment later through your dev server's hot reload.

```
  you                          ezdesign                          your agent
  ───                          ────────                          ──────────
  click the hero title    ──▶  src/sections/Hero.tsx:13     ──▶  edits that line
  "make this 56px"             <Hero ← App>                      page hot-reloads
```

## Quick start

You need Node.js 22.13+ and an app running locally.

**1. Open a review** from your project's root, pointing at the page you want to work on:

```sh
npx -y @cychien/ezdesign@latest http://localhost:5173/pricing --agent claude
```

A review shell opens in your browser with your app inside it and the agent beside it.

**2. Point and comment.** Press `E` and click an element, or `R` and drag over an area. Write what
should change. Repeat for as many things as you like.

**3. Send** with `⌘↵`. The agent works through the batch, streams what it is doing, and the page
updates in place. Review, comment again, send again.

### Or start it from your agent

Add the skill once:

```sh
npx skills add cychien/ezdesign --skill ezdesign
```

Then type `/ezdesign` in Claude Code, Codex or Gemini CLI, and the agent opens the review for you.

### Or use the Mac app

Download it from [Releases](https://github.com/cychien/ezdesign/releases/latest): `ezdesign-arm64.dmg`
for Apple silicon, `ezdesign-x64.dmg` for Intel. Pick a project in its sidebar and start its dev
server from the App tab; the agent connects on its own.

The app is not signed with an Apple Developer ID, so macOS stops it the first time:

1. Open the DMG and drag **ezdesign** into **Applications**, then open it. macOS says it cannot
   verify the developer; choose **Done**.
2. Open **System Settings → Privacy & Security**, scroll to the note about ezdesign, choose
   **Open Anyway**, and confirm.

After that it opens normally. (In Terminal, `xattr -dr com.apple.quarantine /Applications/ezdesign.app`
does the same.) New versions install from inside the app: when one is out, the foot of the sidebar
offers **重新啟動以更新**, and the app restarts on it. A copy opened straight from the DMG cannot
replace itself, so drag it into Applications first.

### Exact `file:line` for Vite + React

ezdesign works with any framework, no code changes. For Vite + React, add the plugin and every
annotation carries the exact source line:

```ts
// vite.config.ts
import { ezdesignSource } from '@cychien/ezdesign/vite'

export default defineConfig({
  plugins: [ezdesignSource(), react()],
})
```

It only runs in dev (`apply: 'serve'`) and never touches production builds.

## Features

- **Point, don't describe.** Click an element, drag over a region, or select a run of text. Each
  annotation reaches the agent with its source `file:line`, React component chain, selector, text
  and viewport.
- **Every screen size at once.** Preview at phone, tablet or desktop, or lay them all out on one
  grid at true size, scrolling and navigating together.
- **Explore before you commit.** Ask for a few versions of any element and flip through them on the
  real page. Keep the one you like.
- **Canvases beside your app.** The agent draws whole design directions as real HTML pages at real
  widths, on a board next to your app. Pick one and it builds that into your components.
- **A design library from the whole web.** The Chrome extension saves any image, video or region
  of a page, with tags and a note. Pull those into a comment as references.
- **The agent lives in the shell.** Its replies, plan, tool calls, questions and permission
  prompts all show up next to your app. No terminal to babysit.
- **Local-first.** Your code never leaves your machine, and ezdesign uses the agent you already
  have, so there is nothing new to pay for.

## Using the review shell

### Annotating

| Key | Mode | Use it for |
| --- | --- | --- |
| `E` | **Element** | One thing: a button, a heading, a sentence. Click it, or select text. |
| `R` | **Region** | An area: a card, a row of cards, "the spacing through here". Drag a box; whatever it fully encloses is what you meant. |
| `Esc` | | Close the comment box, then leave the mode. |

Annotations queue up beside your app and stay editable until you send. Paste or drop a screenshot,
or any file, straight into a comment and the agent gets a path to it.

### Commands in the comment box

Type `/` in a comment for these:

| Command | What it does |
| --- | --- |
| `/element` | Point at a second element, so "make this match that one" arrives as two exact locations. `⌘`-click to pick, or drag a box. Works across pages and across canvas tabs. |
| `/explore` | Ask for variants of the element you are commenting on, then try each one on the page. |
| `/library` | Attach references from your design library. |
| `/file` | Attach a file from disk. |
| `/new` | Start a fresh conversation with the agent (note box only). Earlier ones stay one click away. |

Type `$` in the note box to run one of your installed agent skills over the batch.

### Shortcuts

| Key | Action |
| --- | --- |
| `⌘↵` | Send the queue to the agent. Sending while it is still working queues the batch for its next turn. |
| `⌘.` | Stop the agent's current turn. |
| `1` `2` `3` | Preview at phone (375), tablet (1112) or desktop (1440). |
| `4` | Show every size on one grid. Drag a card's label to rearrange, drag the background to pan. |

### Choosing the agent and model

The pills above the note box pick the agent and the model, plus reasoning effort where the agent
offers it. Switching models keeps the conversation, so you can move to a stronger model for the
hard part of a review and back again. Switching agents starts a new conversation.

## Agents

| `--agent` | Agent |
| --- | --- |
| `claude` | Claude Code |
| `codex` | Codex |
| `gemini` | Gemini CLI |

ezdesign talks to agents over the [Agent Client Protocol](https://agentclientprotocol.com). Any
other value is run as an ACP server command, so a custom agent works too:
`--agent 'my-acp-agent --flag'`.

## Canvases

A canvas is an infinite board of frames. Each frame is a complete HTML page at a real viewport width,
so a 390 frame is a phone to its media queries however far you zoom out.

- **Open one** from the `+` in the tab strip, or run ezdesign without a url to work on canvases in
  a project that has no dev server yet:
  ```sh
  npx -y @cychien/ezdesign@latest --agent claude
  ```
- **Ask for designs** and the agent adds them as frames. Annotate a frame exactly like your app.
- **Move around** by dragging the background or scrolling. Pinch or `⌘`-scroll to zoom, `⇧1` to fit
  everything, `⇧0` for 100%. Frames snap to each other, and `⌘Z` undoes.
- **Bring one into the app** with `/element`: comment on your app, switch to the canvas, `⌘`-click
  the frame you mean.

Canvases are saved in your project under `.ezdesign/canvases/`. Commit them or ignore them, your
call. Frames are served from a separate origin, so agent-written pages cannot reach the review shell.

## Design library

The Chrome extension saves references into one library under `~/.ezdesign/library/`, shared by
every project. Saving works anytime, with or without a review open.

```sh
npx -y @cychien/ezdesign@latest extension install
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick
`~/.ezdesign/extension`. Works with Chrome, Chromium, Arc, Brave, Edge and Vivaldi on macOS and
Linux.

- **Right-click any image or video** and save it to ezdesign.
- **Press `Alt+Shift+S`** (or click the toolbar icon) and drag over any part of a page.
- Add tags and a note on why it is good, so the agent knows how to use it later.

`ezdesign extension status` checks the install, and `ezdesign extension uninstall` removes it while
keeping your library.

## Sessions and updates

A review belongs to your project (the nearest `.git` or `package.json`), not to a port. Restart
your dev server on another port and run ezdesign again: the shell switches over and the
conversation and queue carry on.

Reviews survive restarts. The background daemon brings its sessions back on the ports they held,
your open shell reconnects on its own, and the agent resumes the conversation it was in.

When a newer version is out, a card at the top of the shell offers it. One click installs it and
hands your sessions over, and if the new version fails to start you stay on the one you had.
Always run the CLI as `npx -y @cychien/ezdesign@latest`; a bare `npx @cychien/ezdesign` keeps
using whatever version npx cached. Update the skill with `npx skills update ezdesign`.

## CLI

```
ezdesign [<url>] --agent <name>   open or resume this project's review
ezdesign status                   show running sessions
ezdesign stop                     stop the background daemon
ezdesign extension install        set up the Chrome extension
ezdesign --help                   everything else
```

`ezdesign` here is short for `npx -y @cychien/ezdesign@latest`.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `EZDESIGN_DATA_DIR` | `~/.ezdesign` | Where sessions, the daemon's registry and log, and installed versions live. A separate dir runs a fully isolated instance. |
| `EZDESIGN_CONTROL_PORT` | `4400` | First of the ten ports the daemon tries for its control server. |
| `EZDESIGN_NO_UPDATE_CHECK` | unset | `1` never asks npm for a newer version. |
| `EZDESIGN_NO_IDLE_STOP` | unset | `1` keeps the daemon running when idle. By default it stops after 30 minutes with no shell open. |

## Privacy

The daemon binds to `127.0.0.1` and your code stays on your machine. Apart from your agent's own
traffic, ezdesign reaches out only to npm, to fetch the agent adapter and to check for a newer
version (at most every four hours, off with `EZDESIGN_NO_UPDATE_CHECK=1`), and to the ezdesign
backend for sign-in and inspiration search when you use them.

## Development

```sh
npm run dev                 # watch src/, serve the playground fixture, open a review with an agent
npm run dev -- --no-plugin  # the same, without the Vite plugin, to see fallback anchors
npm run dev:cli status      # the CLI, pointed at the dev daemon
npm run brand               # regenerate logo assets after editing src/brand.ts
npm run check               # build, typecheck, test
```

Dev mode keeps its state in `.dev/`, so your own `~/.ezdesign` is never touched, and each checkout
picks its own ports, so worktrees run side by side. The review target is
[`fixtures/playground`](fixtures/playground/README.md).

## Status

Early and moving fast. Feedback and issues are welcome.

## License

MIT
