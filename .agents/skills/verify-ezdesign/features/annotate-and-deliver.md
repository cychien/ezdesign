# Annotate and deliver

A user arms a mode in the review shell, picks an element (or drags a box) on their live page, writes a comment, queues it, and sends the queue to the agent; the agent's `poll` receives the batch with a layered anchor whose `source` is the exact `file:line`, and the agent's progress, reply and end show up in the shell.

## Sub-features

- `annotate-element` picks one element in 元素 mode and opens the comment box on it.
- `annotate-region` drags a box in 範圍 mode; what the box encloses whole is the subject.
- `annotate-queue` adds the comment to the 待送清單 with its `file:line · section · "text"` label and a numbered pin on the page.
- `deliver-send` sends the queue as one batch; a waiting `poll` prints it and exits 0.
- `deliver-anchor` the batch carries `anchor.source`, `components`, `section`, `selector`, `text`, `rect`, `viewport`, `page`.
- `agent-status` the shell shows Agent 未連線 / 已連線 / 修改中 from the poller's state.
- `agent-progress` `ezdesign progress` replaces the status line text.
- `agent-reply` `poll --agent-reply` appends the reply under the batch in the thread.
- `agent-end` `ezdesign end` ends the session; the shell disables annotating and sending and says so.

## How to get to it (user POV)

- Press `e` or choose `元素`, click an element on the page.
- Press `r` or choose `範圍`, drag a box over the page.
- Choose `加入待送清單` or press `⌘+Enter` in the comment box.
- Choose `送出給 agent` or press `⌘+Enter` outside the comment box.
- As the agent, from the project: `ezdesign poll`, `ezdesign progress <msg>`, `ezdesign poll --agent-reply <msg>`, `ezdesign end`.

## Driving it with chrome-devtools-axi and vz.mjs

Preconditions:

- `baseline` loaded, `doctor` green, the shell open: `npx -y chrome-devtools-axi open "$($V/vz.mjs get shellUrl)"`.
- The sidebar shows `"Agent 未連線"` and no queued rows.
- Evidence folder: `E=$($V/vz.mjs get evidenceDir)/annotate-and-deliver; mkdir -p $E`.

- **Arm element mode.** Choose 元素. Run `npx -y chrome-devtools-axi click @<button "元素">`. `eval "() => document.querySelector('.ez-mode-element').className"` contains `ez-on`.
- **Pick the hero heading.** Click it inside the frame. Run `npx -y chrome-devtools-axi click @<heading "週報不用開會寫。 讓進度自己浮出來。">`. The snapshot gains `textbox "想怎麼調整？輸入 / 用指令 (⌘+Enter 送出)"` (focused), `button "取消"`, `button "加入待送清單"`.
- **Write the comment.** Run `npx -y chrome-devtools-axi fill @<that textbox> "把標題字級放大一點"`, then `npx -y chrome-devtools-axi screenshot $E/01-comment-box.png`. The heading is framed and the box shows the text.
- **Queue it.** Choose 加入待送清單. Run `npx -y chrome-devtools-axi click @<button "加入待送清單">`. The sidebar shows `"1"`, `"src/sections/Hero.tsx:13 · hero · "週報不用開會寫。讓進度自己浮出來。""` and the comment; `<session>/queue.json` holds one item with `anchor.source` `src/sections/Hero.tsx:13`.
- **Oracle for the line.** Run `grep -n '<h1>' fixtures/playground/src/sections/Hero.tsx`. It prints `13:`; the anchor must match it.
- **Start the agent.** Run `$V/vz.mjs cli -- poll > $E/poll.json; echo $? > $E/poll.exit` in the background. Within a second the sidebar reads `"Agent 已連線"`.
- **Send.** Choose 送出給 agent. Run `npx -y chrome-devtools-axi click @<button "送出給 agent">`. The thread shows `"1."` and the comment, and `status "Agent 修改中"` appears; `poll.exit` is `0` and `poll.json` is `{"type":"feedback", ...}` whose item has `label` starting `src/sections/Hero.tsx:13 · <Hero ← App> · [section: hero]` and `anchor.source` `src/sections/Hero.tsx:13`. `<session>/outbox.json` has the batch with `ackedAt` set.
- **Progress.** Run `$V/vz.mjs cli -- progress "正在調整 hero 標題字級"`. Exit 0; the snapshot shows `status "正在調整 hero 標題字級"`.
- **Reply.** Run `$V/vz.mjs cli -- poll --agent-reply "已把 hero 標題放大到 56px" > $E/poll2.json` in the background. The thread shows the reply under the batch, the status returns to `"Agent 已連線"`, and `<session>/conversation.json` ends with `{"role":"agent","text":"已把 hero 標題放大到 56px"}`. Screenshot `$E/02-thread-after-reply.png`.
- **End.** Run `$V/vz.mjs cli -- end`. It prints `session for <repo>/fixtures/playground ended`; the pending poll exits 0 with `{"type":"session-ended","endedBy":"agent"}`; the thread adds `"Session ended by agent"` and `"Agent 已結束這次 review。要繼續的話，請 agent 重新開啟 session"`; `元素`, `範圍` and `送出給 agent` are `disabled`.
- **Region.** After `$V/vz.mjs seed baseline` and reopening the shell, press `r`, then `npx -y chrome-devtools-axi drag @<"4.5 小時"> @<"正在使用的團隊">` with both refs from one snapshot (see SKILL.md). A comment box opens on the one element the box enclosed whole: the queued row reads `src/sections/Stats.tsx:15 · stats · "92%"` (oracle: `grep -n 'stat-value' fixtures/playground/src/sections/Stats.tsx` prints `15:`).
- **Browser health.** Run `npx -y chrome-devtools-axi console --type error`. Expect only the `/favicon.ico` 404 noted below.

## Gotchas

- `poll` blocks and is the only thing that flips the status to 已連線; start it in the background before sending, or the batch waits in the outbox (that is correct behavior, but nothing prints).
- `drag` goes from the center of one element to the center of another, so the drawn box cuts through both endpoints and they are looked past. Pick endpoints that bracket what you mean; a 7px-wide box (endpoints stacked vertically) falls back to an element it does not enclose. Proving `anchor.contains` needs a box that encloses two or more elements whole, which this map has not pinned down yet.
- A mode button is armed when its `aria-pressed` is `"true"` (`pressed` in the snapshot). Pressing `e`/`r` toggles, so pressing it on an armed mode disarms it.
- A single 電腦 preview takes the stage's own size, so `anchor.viewport` reads the frame width (856 in a 1200px-wide headless window) with `preset: "desktop"`, not 1440.
- The shell requests `/favicon.ico` through the proxy and the fixture has none: one console error `404 (Not Found)` on every shell load. Known, not caused by your change.
- Do not use `--agent` here: an ACP agent also consumes every batch and edits the fixture.
