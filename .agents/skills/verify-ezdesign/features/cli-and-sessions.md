# CLI and sessions

The `ezdesign` CLI is how a user starts a review and how an agent works it: it opens (or restores) a session for a dev server and spawns the background daemon, reports status, stops the daemon, stores the inspiration token, and validates its environment before doing anything.

## Sub-features

- `cli-help` `--help` prints usage and the environment table, exit 0. No args is an open with no url: the shell opens on the project's canvases.
- `cli-version` `--version` prints `package.json`'s version.
- `cli-open` `ezdesign <url>` from the project dir spawns the daemon on demand, prints `session: <project>`, `app: <origin>`, `shell:`, `next:`, and asks the OS to open the shell in a new browser window. Run again with another port, it keeps the session and moves the App to that port.
- `cli-resolve` `poll`, `progress` and `end` find the session by the project they run from; a url given to them only adds a `note:` when it is not the attached app, and a project with no session fails with the open sessions listed.
- `cli-open-errors` a missing url, a non-http url, or nothing listening exit 1 with `error:` and `hint:` lines.
- `cli-status` `status` lists the daemon (version, pid, control port) and every session by project, with its attached app.
- `cli-stop` `stop` stops the daemon; `status` then says `daemon: not running`.
- `cli-env` `EZDESIGN_CONTROL_PORT` outside 1024-65525 is fatal at the command; `EZDESIGN_DATA_DIR` moves all state.
- `cli-login` `login` prompts on a TTY, refuses without one, writes `credentials.json` mode 600; `logout` removes it; `inspire` without a token exits 2.
- `cli-reopen` a session ended by the agent reopens with `ezdesign <url>`; one ended by the user needs `--reopen`.

## How to get to it (user POV)

- `ezdesign --help`, `ezdesign --version`, `ezdesign <url>`, `ezdesign status`, `ezdesign stop`, `ezdesign login [--token t]`, `ezdesign logout`, `ezdesign inspire --query "<text>"`, `ezdesign poll`, `ezdesign progress <msg>`, `ezdesign end`, `ezdesign <url> --reopen`.

## Driving it with chrome-devtools-axi and vz.mjs

Preconditions:

- Stack up on `baseline`. `T=$PWD/$V/term.py CLI=$PWD/dist/cli.mjs; eval "$($V/vz.mjs env)"; cd fixtures/playground` for the TTY steps.
- `E=$($V/vz.mjs get evidenceDir)/cli-and-sessions; mkdir -p $E`; tee every command's output there.

- **Help and version.** Run `$T -- node $CLI --help` and `$T -- node $CLI --version`. Exit 0; the first starts `ezdesign - annotate your live dev app` and lists `EZDESIGN_DATA_DIR`, `EZDESIGN_CONTROL_PORT`, `EZDESIGN_NO_UPDATE_CHECK`, `EZDESIGN_INSPIRE_URL`; the second prints `0.7.0` (whatever `package.json` says).
- **Status.** Run `node $CLI status`. `daemon: running (v<version>, pid <vz get daemonPid>, control port <vz get controlPort>)` and `session: <repo>/fixtures/playground → 127.0.0.1:NNNNN (active)` with `app: http://localhost:NNNN`.
- **Open.** Run `node $CLI <origin>` from `fixtures/playground`. Exit 0, four lines (`session: <repo>/fixtures/playground`, `app:     <origin>`, `shell:`, `next:    run \`ezdesign poll\` in this project ...`), and `$V/vz.mjs get opened` gains `open --new -a google chrome --args --new-window <shell url>` (the shim caught the browser launch).
- **Open errors.** `node $CLI poll ftp://x` -> exit 1 `error: invalid url: ftp://x`; `node $CLI http://localhost:1/` -> exit 1 `error: nothing is listening at http://localhost:1` and a `hint:`; `node $CLI poll` from the repo root -> exit 1 `error: no session for <repo>` and a hint listing `<repo>/fixtures/playground (<origin>)`.
- **Resolve.** From `fixtures/playground`, `node $CLI progress http://localhost:1 "x"` -> exit 0 with `note: http://localhost:1 is not this project's app (attached: <origin>); using the project session` on stderr.
- **Env.** `EZDESIGN_CONTROL_PORT=80 node $CLI status` -> exit 1 `error: EZDESIGN_CONTROL_PORT must be an integer between 1024 and 65525, got "80"`.
- **Login on a TTY.** Run `$T --expect 'inspiration token:' --send 'tok-123\n' -- node $CLI login`. Exit 0, `token saved to <data dir>/credentials.json`; `stat -f %Sp` on it is `-rw-------`; its content is `{"inspire":{"token":"tok-123"}}`. Then `node $CLI login </dev/null` -> exit 1 `error: no token given` with the `--token` hint; `node $CLI logout` -> `inspiration token removed`; `node $CLI inspire --query x` -> exit 2 `error: no inspiration token; run \`ezdesign login\` first`.
- **End and reopen.** `node $CLI end` -> `session for <repo>/fixtures/playground ended`; `node $CLI <origin>` from the fixture reopens it (exit 0) and the shell's 元素 button is enabled again after a reload.
- **Stop.** Last, `node $CLI stop` -> `daemon stopped`, then `node $CLI status` -> `daemon: not running`. `$V/vz.mjs doctor` now fails on the daemon lines; `$V/vz.mjs down` still cleans up.

## Gotchas

- Run the CLI from `fixtures/playground`: the session is that project's. `ezdesign <origin>` from elsewhere opens another project's session and moves the fixture origin to it, and the fixture session is left with no app.
- `login` echoes the token as it is typed (no masking); the transcript shows it in clear.
- `inspire` with a token queries `https://inspire.ezdesign.dev` over the network; set `EZDESIGN_INSPIRE_URL` to a local stub before driving it, or report it as not driven.
- `stop` ends this run's daemon; `$V/vz.mjs seed baseline` brings it back.
- Without the `open` shim (a bare terminal), `ezdesign <url>` launches the real default browser on the desktop. Always `eval "$($V/vz.mjs env)"` first.
