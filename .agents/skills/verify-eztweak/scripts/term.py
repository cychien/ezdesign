#!/usr/bin/env python3
"""Run a command on a real pseudo-terminal, answer prompts, print the transcript.

usage: term.py [--expect REGEX --send TEXT]... [--timeout SECS] -- CMD [ARGS...]

Each --expect/--send pair waits until REGEX appears in the output, then types TEXT
(escape sequences like \\n are honoured). Exits with the command's exit code.
"""
import os
import pty
import re
import select
import sys
import time


def main() -> int:
    argv = sys.argv[1:]
    if "--" not in argv:
        print(__doc__, file=sys.stderr)
        return 2
    split = argv.index("--")
    opts, cmd = argv[:split], argv[split + 1 :]
    steps, timeout = [], 20.0
    i = 0
    while i < len(opts):
        if opts[i] == "--expect":
            steps.append([opts[i + 1], None])
        elif opts[i] == "--send":
            steps[-1][1] = opts[i + 1].encode().decode("unicode_escape")
        elif opts[i] == "--timeout":
            timeout = float(opts[i + 1])
        i += 2

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)

    out = b""
    deadline = time.time() + timeout
    while True:
        if steps and re.search(steps[0][0], out.decode(errors="replace")):
            os.write(fd, steps.pop(0)[1].encode())
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        if time.time() > deadline:
            os.kill(pid, 9)
            print(f"term.py: timed out after {timeout}s", file=sys.stderr)
            break
    _, status = os.waitpid(pid, 0)
    sys.stdout.write(out.decode(errors="replace"))
    if steps:
        print(f"term.py: never saw {steps[0][0]!r}", file=sys.stderr)
        return 3
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
