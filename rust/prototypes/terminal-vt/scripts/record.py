#!/usr/bin/env python3
"""Record the bytes a program writes to a pty of a fixed size, with `script`.

Usage: record.py <fixture dir> <cols> <rows> <seconds> <shell command>

Runs the command under util-linux `script` in a pty of <cols> x <rows>, kills
it with SIGKILL after <seconds> (so a full-screen program is still on its
alternate screen when the recording ends), and, unless the command failed
(an exit status other than 0, or 137 from the kill), writes:

  <fixture dir>/output.bin  the bytes the pty's master side read, unchanged
  <fixture dir>/size.txt    "<cols>x<rows>"

`script -O` puts a header line before the bytes and a footer after them; the
timing file (`-m advanced -T`) gives the byte count of each output event, so
the header is the first line and the bytes are the next sum(O) bytes.

The command gets a minimal environment: PATH, HOME, TERM=xterm-256color,
COLORTERM=truecolor, LANG=en_US.UTF-8, and whatever the caller adds with
`env` inside the command. No HERDR_* variable reaches it. Nothing is typed
into the program: stdin is a pipe that stays open and silent.
"""

import os
import shlex
import subprocess
import sys
import tempfile


def main() -> None:
    if len(sys.argv) != 6:
        sys.exit(__doc__)
    out_dir, cols, rows, seconds, command = sys.argv[1:]
    cols_n, rows_n = int(cols), int(rows)
    os.makedirs(out_dir, exist_ok=True)

    inner = (
        f"stty rows {rows_n} cols {cols_n}; "
        f"exec timeout -s KILL {float(seconds)} sh -c {shlex.quote(command)}"
    )
    env = {
        "PATH": os.environ["PATH"],
        "HOME": os.environ["HOME"],
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": "en_US.UTF-8",
    }
    with tempfile.TemporaryDirectory() as tmp:
        log = os.path.join(tmp, "log")
        timing = os.path.join(tmp, "timing")
        # A pipe that stays open: the program reads no input and sees no EOF.
        holder = subprocess.Popen(["sleep", str(float(seconds) + 5)], stdout=subprocess.PIPE)
        result = subprocess.run(
            ["script", "-q", "-e", "-E", "never", "-m", "advanced", "-T", timing, "-O", log, "-c", inner],
            stdin=holder.stdout,
            stdout=subprocess.DEVNULL,
            env=env,
            check=False,
        )
        holder.kill()
        # 0: the command ended by itself; 137: timeout killed it (128 + SIGKILL).
        if result.returncode not in (0, 137):
            sys.exit(f"{out_dir}: the command exited with {result.returncode}; nothing written")
        data = extract(log, timing)

    with open(os.path.join(out_dir, "output.bin"), "wb") as f:
        f.write(data)
    with open(os.path.join(out_dir, "size.txt"), "w") as f:
        f.write(f"{cols_n}x{rows_n}\n")
    print(f"{out_dir}: {len(data)} bytes, {cols_n}x{rows_n}")


def extract(log: str, timing: str) -> bytes:
    total = 0
    with open(timing) as f:
        for line in f:
            parts = line.split(" ", 2)
            if parts[0] == "O":
                total += int(parts[2])
    with open(log, "rb") as f:
        raw = f.read()
    start = raw.index(b"\n") + 1
    if not raw[start + total :].lstrip(b"\n").startswith(b"Script done"):
        sys.exit("unexpected script log layout")
    return raw[start : start + total]


if __name__ == "__main__":
    main()
