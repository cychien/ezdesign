---
name: verify-ezdesign
description: "Drive ezdesign the way a user does: launch an isolated fixture app + ezdesign daemon, annotate the live page in the review shell (/__ezdesign/shell) through a real Chrome via chrome-devtools-axi, read the batch back with `ezdesign poll`, drive the CLI on a real pty, and install the packed tarball as a consumer would. Use to prove any change to the shell UI, overlay, daemon, CLI, vite plugin, or packaging before calling it done."
---

# verify-ezdesign

ezdesign has three user surfaces. The **review shell** in a browser is the primary one: a user opens `http://127.0.0.1:<session-port>/__ezdesign/shell?path=/`, picks elements on their live page (proxied in an iframe with an overlay injected), and sends annotations to an agent. The **CLI** (`dist/cli.mjs`, bin `ezdesign`) is the second: it opens sessions, spawns the background daemon, and is the agent's side of the loop (`poll`, `progress`, `end`). The **npm tarball** is the third: `ezdesign` bin, the `ezdesign/vite` export (`ezdesignSource()`), and the bundled `skills/ezdesign/`.

Everything goes through one helper, `scripts/vz.mjs`. Commands below run from the repo root with:

```
V=.agents/skills/verify-ezdesign/scripts
```

## Launch

```
$V/vz.mjs up                      # baseline dataset
$V/vz.mjs up --dataset large      # or start straight on another dataset
```

`up` installs deps when `node_modules/vite` is missing (`pnpm install --frozen-lockfile --config.strict-dep-builds=false`, see Gotchas), runs `npm run build`, starts the fixture (`fixtures/playground`, vite with `ezdesignSource()`) on a free port with `--strictPort`, writes the dataset into an empty data dir, and then opens the session the way a user does: `ezdesign http://localhost:<fixture-port>/` run from `fixtures/playground`, which spawns the daemon on demand. Takes about 3 seconds after the first build.

Ready means usable, and `up` waits for all of it before printing `ready`:

- `GET <fixture>/src/sections/Hero.tsx` returns JSX stamped with `data-ez-source` (vite up, plugin applied).
- the CLI printed `shell: http://127.0.0.1:<port>/__ezdesign/shell?path=%2F` and exited 0.
- the shell URL returns 200 and the proxied page `http://127.0.0.1:<port>/` contains `/__ezdesign/overlay.js`.

Output ends with:

```
fixture  http://localhost:54xx/ (vite pid N)
dataset  baseline loaded into <run dir>/data
daemon   pid N, control range 4xx0-4xx9
shell    http://127.0.0.1:NNNNN/__ezdesign/shell?path=%2F
ready    run `vz.mjs doctor` next
```

`$V/vz.mjs status` prints the recorded state as JSON (urls, ports, pids, data dir, `sessionDir`, evidence dir, and `opened`: every browser launch the CLI attempted). `$V/vz.mjs get <field>` prints one of them, for scripting.

### Isolation

- **Per checkout, side by side: yes.** The run dir is `$TMPDIR/ezdesign-verify-<sha1(repo path)[:8]>` (override with `EZDESIGN_VERIFY_RUN_DIR`), holding the daemon data dir (`EZDESIGN_DATA_DIR`), logs, and state. The control range starts at a free 10-port block in 4600-4999 (`EZDESIGN_CONTROL_PORT`), the fixture at a free port from 5400. Two worktrees each get their own stack.
- **Never touches the user's ezdesign**: their daemon is on 4400-4409 with `~/.ezdesign`; `doctor` fails if ours is not inside its own range.
- **No desktop browser window.** The CLI calls the `open` package, which spawns `open`/`xdg-open` from `PATH`; `vz.mjs` puts shims first on `PATH` that append to `<run dir>/opened.log` instead. The proof that the CLI tried to open the shell is that log line (`open --new -a google chrome --args --new-window http://127.0.0.1:.../__ezdesign/shell?path=%2F`).
- `EZDESIGN_NO_UPDATE_CHECK=1` is set, so the daemon never asks the npm registry.
- **One stack per checkout.** `up` refuses while one is recorded alive; run `down` first.
- **Why not `npm run dev`.** It is the human dev loop, not a verification harness: it always attaches an ACP `claude` agent (a real model that edits `fixtures/playground` and races `poll` for every batch), it opens a real browser window, and its control port 4410 is fixed - a second checkout's `npm run dev` finds the first one's daemon on 4410 and stops it (`clearStrayDaemon` in `scripts/dev.mjs`; read from the code, not driven). Its `.dev/` data dir is per checkout. Do not drive a `npm run dev` stack you did not start.

## Seed

Datasets live in `datasets/*.json` and are written straight into the daemon's on-disk format (`<data>/sessions/<sha1(origin + "\n" + project)[:12]>/{session,queue,outbox,conversation}.json`), never through the daemon's API. Loading wipes the run's data dir first and uses a fixed epoch and position-derived ids, so loading twice gives the same state.

```
$V/vz.mjs seed baseline
$V/vz.mjs seed large
```

`seed` stops our daemon, rewrites the data dir, and reopens the session with the CLI, which restarts the daemon and restores the sessions from disk. The session port usually changes: always take the shell URL from the `seed` output or `vz.mjs status`.

| Dataset | What it is |
| --- | --- |
| `baseline` | Fixture playground as committed, empty daemon data dir: no sessions, no history. The session is created by the CLI. Every mapped feature is reachable from it; the drives create their own annotations. |
| `large` | Production-like volume: the fixture session with 6 chats and 330 acked batches of 3 items (660 log entries, 360 in the visible chat), 40 queued annotations on real fixture `file:line` anchors, plus 120 ended and 4 active sessions on other origins (the active ones are restored with proxies to dead dev servers, as a long-lived daemon has). |

Measured on an M-series Mac: loading `large` takes about 0.6 s including the daemon restart, and the shell document loads in about 100 ms with it; use those as the baseline for a perf check.

The fixture page itself is the other half of the data: `fixtures/playground` is a fake product page (Cadence) whose sections each exercise one anchor layer (see `fixtures/playground/README.md`). Treat it as read-only.

## Doctor

```
$V/vz.mjs doctor
```

Read-only; exit 0 only when every line is `ok`. It checks: the stack belongs to this checkout, HEAD unchanged since `up`, `dist/cli.mjs` newer than everything in `src/` (the right build), vite pid alive and serving stamped JSX, the registry in our data dir names our daemon pid, `/control/health` on that port answers with our pid and `package.json`'s version, the control port is inside our range, the fixture session is `active` and scoped to `fixtures/playground`, the shell URL serves the shell, and the proxied page carries the overlay. Run it first and whenever anything looks off. A stale build means `down` then `up`.

## Drive

### Browser: the review shell (chrome-devtools-axi)

Use one named axi session per checkout so parallel runs do not share a browser, and run it as `npx -y chrome-devtools-axi`:

```
export CHROME_DEVTOOLS_AXI_SESSION=$($V/vz.mjs get axiSession)
npx -y chrome-devtools-axi open "$($V/vz.mjs get shellUrl)"
```

Element refs look like `@g7:1_136`; the `gN` prefix changes after every command (a `snapshot` included), and a stale ref is ignored without an error. Take refs from the latest snapshot every time, and take every ref one command needs (both ends of a `drag`) from the same snapshot:

```
snap=$(npx -y chrome-devtools-axi snapshot)
A=$(echo "$snap" | grep -F '"4.5 小時"' | grep -o 'g[0-9]*:[0-9_]*'); B=$(echo "$snap" | grep -F '"正在使用的團隊"' | grep -o 'g[0-9]*:[0-9_]*')
npx -y chrome-devtools-axi drag @$A @$B
```

Run axi from a neutral directory (or give `screenshot` absolute paths): relative output paths resolve against the cwd. The fixture page is inside `Iframe "電腦 · 1440×788"` and is fully present in the ARIA tree; the shell is the `complementary` region. Stable handles (accessible names):

| Handle | What it is |
| --- | --- |
| `button "元素"` / key `e` | element mode (class `ez-on` on `.ez-mode-element` when armed; there is no `aria-pressed`) |
| `button "範圍"` / key `r` | region mode (drag a box) |
| `textbox "想怎麼調整？輸入 / 用指令 (⌘+Enter 送出)"` | the comment box on the page, with `button "取消"` and `button "加入待送清單"`; `Meta+Enter` also adds |
| `button "改這則標註（送出前都還能改）"` / `button "移除這則標註"` | per queued row; editing shows `button "儲存（⌘+Enter）"`, `button "取消（Esc）"` |
| `textbox "整體想法或補充說明，輸入 / 用指令（選填）"` / key `n` | the batch note box |
| `button "送出給 agent"` / `Meta+Enter` | send the queue as one batch |
| `"Agent 未連線"` / `"Agent 已連線"` / `status "Agent 修改中"` | agent state: no poller / a `poll` is waiting / a batch is out |
| `button "電腦"`, `button "換一個尺寸"`, `button "全部尺寸"` / keys `1` `2` `3` `4` | device size, size menu, all-sizes canvas |
| `button "快捷鍵"` | shortcut panel |

Plain keys (`e`, `r`, `n`, `1`-`4`) are ignored while a text field has focus; press `Escape` first.

Check the browser side after every flow: `npx -y chrome-devtools-axi console --type error` and `npx -y chrome-devtools-axi eval "() => performance.getEntriesByType('resource').filter(e => e.responseStatus >= 400).map(e => e.responseStatus + ' ' + e.name)"`.

### Terminal: the CLI

`$V/vz.mjs cli -- <args>` runs `dist/cli.mjs` with this stack's env from `fixtures/playground` (the project the session is scoped to). For anything that needs a real terminal (the `login` prompt only appears when stdin is a TTY), use `scripts/term.py`, which runs a command on a pseudo-terminal, answers prompts, and prints the transcript:

```
T=$PWD/$V/term.py CLI=$PWD/dist/cli.mjs
eval "$($V/vz.mjs env)"           # exports EZDESIGN_DATA_DIR, EZDESIGN_CONTROL_PORT, EZDESIGN_NO_UPDATE_CHECK, PATH shims
$T -- node $CLI --version
$T --expect 'inspiration token:' --send 'tok-123\n' -- node $CLI login
```

Run `ezdesign <url>` itself from `fixtures/playground` (`cd fixtures/playground` first): a session is scoped to the project the CLI runs from, and run from the repo root it replaces the fixture's session on that origin with a fresh one scoped to the ezdesign repo. There is no tmux on this machine; `term.py` stands in for it.

### Package: consumer install

```
$V/vz.mjs consumer
```

Builds, `npm pack`s, checks the tarball holds `dist/{cli,vite}.mjs`, `dist/vite.d.ts`, `dist/{shell,overlay}.{js,css}`, `skills/ezdesign/SKILL.md`, README, LICENSE and nothing from `src/ test/ fixtures/ scripts/`, installs it into a fresh temp project with an isolated `HOME`, its own data dir and control range, then drives the installed bin (`--version`, `--help`, `status`, a bad `EZDESIGN_CONTROL_PORT`), imports `ezdesign/vite` and transforms a JSX snippet, and - when a stack is up - opens a session on the fixture from the installed bin and fetches the shell and `shell.js` from its daemon before `stop`. Writes `consumer/transcript.txt` and `consumer/tarball-files.txt` into the evidence dir; exit 0 only when every step passed.

The feature map in `features/` has the per-feature recipes.

## Evidence

```
$V/vz.mjs evidence     # prints and creates the directory
```

It is what `python3 ~/.claude/skills/verify/scripts/verify.py where` prints for this branch (`~/.agents/verify/<repo>-<hash>/<branch>/`), outside the diff; set `VZ_EVIDENCE_DIR` to override. Put each feature's artifacts in a subfolder named after its feature file.

Proof standards:

- Drive the real user path: clicks and keys in the shell, the CLI as a user or agent runs it. Never post to `/__ezdesign/api/*` to create the state you are proving.
- Capture the action and the resulting state: a screenshot with the comment box open, a snapshot after the queue changes, the `poll` JSON after the send - not just the final screen.
- Verify side effects alongside the screen: `queue.json`/`outbox.json`/`conversation.json` in `<data dir>/sessions/<key>/`, `credentials.json` and its mode, `opened.log`, the `poll` exit code.
- Check `anchor.source` against the source independently (`grep -n` the element in `fixtures/playground/src`), not against what the shell displays.
- CLI proof is the command, stdout, stderr and exit code.
- Nothing is mocked except the desktop browser launch, which the `open` shim replaces; `opened.log` shows the URL it would have opened.

## Cleanup

```
$V/vz.mjs down
npx -y chrome-devtools-axi stop          # with the same CHROME_DEVTOOLS_AXI_SESSION
```

`down` copies the run's logs (build, vite, every daemon log, `opened.log`) into `<evidence>/vz-logs/<timestamp>/`, stops our daemon through its control port, waits for every daemon pid this run recorded and escalates to SIGTERM/SIGKILL only while that pid's command line is still our `dist/cli.mjs __daemon`, kills ACP agent groups listed in our data dir's `agent-children.json`, kills the vite process group it spawned (same command-line guard), and removes the run dir. It never kills by process name and never touches the evidence dir. It exits 1 and names any pid still alive. Run it after every failed attempt too.

## Helpers

| Helper | Invocation |
| --- | --- |
| `scripts/vz.mjs` | `$V/vz.mjs help` lists `up`, `seed <name>`, `doctor`, `cli -- <args>`, `env`, `status`, `get <field>`, `evidence`, `consumer`, `down` |
| `scripts/term.py` | `$V/term.py [--expect REGEX --send TEXT]... [--timeout S] -- CMD...` - real pty, exits with the command's code (3 when an expected prompt never came) |

## Gotchas

- `pnpm install` exits 1 on this repo (`ERR_PNPM_IGNORED_BUILDS`): `pnpm-workspace.yaml` carries the placeholder `allowBuilds: esbuild: set this to true or false`. `--config.strict-dep-builds=false` installs fine; esbuild works from its platform package without its postinstall.
- `vz.mjs consumer` rebuilds `dist/`; a running daemon keeps the node bundle it started with (client assets are re-read per request). `doctor` still passes, but restart with `down`/`up` before proving daemon-side changes.
- A session ended by the agent reopens with a plain `ezdesign <url>`; one ended by the user needs `--reopen`.
- The daemon stops itself after 30 minutes idle with sessions open (`IDLE_STOP_MS`).
- ACP mode (`--agent claude|codex|gemini`) needs a real agent login and edits the fixture. This driver proves poll mode; ACP-only UI (`/new`, `/resume`, the model pill, 增強設計) is not covered.
