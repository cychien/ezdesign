# ezdesign verification map

This directory is the maintained source for verifying ezdesign's user-facing behavior. Read the index before driving the app, then use the matching feature file as the recipe. `../SKILL.md` covers launch, seed, doctor, evidence and cleanup.

## Baseline preconditions

- Run from the repo root with `V=.agents/skills/verify-ezdesign/scripts`.
- `$V/vz.mjs up` has printed `ready`, and `$V/vz.mjs doctor` exits 0.
- The dataset is `baseline` unless a recipe says otherwise (`$V/vz.mjs seed <name>` to switch).
- `export CHROME_DEVTOOLS_AXI_SESSION=$($V/vz.mjs get axiSession)` before any browser step.
- Never drive a stack this run did not start: not the user's `~/.ezdesign` daemon, not a `npm run dev` stack.

## Driving conventions

- Browser steps use `npx -y chrome-devtools-axi`. Refs (`@gN:x_y`) go stale after every command; take them from the latest snapshot, by accessible name.
- Terminal steps use `$V/vz.mjs cli -- <args>`, or `$V/term.py` when the command needs a TTY.
- `<origin>` below means `$($V/vz.mjs get fixtureOrigin)/`, and `<session>` means `$($V/vz.mjs get sessionDir)`.
- Start every recipe from a fresh `baseline` load (`$V/vz.mjs seed baseline`) when an earlier recipe changed the session.

## Proof and skip reporting

- UI proof is a screenshot plus the ARIA snapshot lines that show the state, taken after the action.
- Mutation proof includes the session files on disk (`queue.json`, `outbox.json`, `conversation.json`) or the `poll` JSON, not only the shell.
- `anchor.source` is checked against `grep -n` on `fixtures/playground/src`, never against what the shell prints.
- CLI proof is the command, stdout, stderr and exit code.
- Record the feature file and entry point with every artifact; report an unreachable entry point with the command tried and the missing precondition, never as verified through another path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph describing the user-visible behavior, then exactly four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with chrome-devtools-axi and vz.mjs`, `Gotchas`.

## Features

- [Annotate and deliver](./annotate-and-deliver.md) covers element and region annotation, the comment box, sending, and the agent side (`poll`, `progress`, reply, `end`) with the `file:line` anchor.
- [Queue and note](./queue-and-note.md) covers editing and removing queued annotations, the batch note, and keyboard sends.
- [Device previews](./device-previews.md) covers the single-size previews, the size menu, and the all-sizes canvas.
- [CLI and sessions](./cli-and-sessions.md) covers the terminal surface: help, version, open, status, stop, env handling, login/logout/inspire, session end and reopen.
- [Consumer install](./consumer-install.md) covers the packed tarball: contents, bin, `ezdesign/vite`, and a session from the installed daemon.
