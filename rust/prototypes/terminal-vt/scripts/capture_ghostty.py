#!/usr/bin/env python3
"""Write each fixture's ghostty-screen.txt with the Ghostty on this PC.

Usage: capture_ghostty.py <fixture dir>...

Needs Ghostty (1.4.0 for the committed fixtures) and Hyprland (0.56, whose
`hyprctl dispatch` takes Lua). For each fixture:

1. Opens a floating Ghostty window through Hyprland with none of the user's
   Ghostty config (`--config-default-files=false`), its own process
   (`--gtk-single-instance=false`), no decorations or padding, and a grid of
   the fixture's size (`--window-width` / `--window-height` in cells). It
   runs ghostty_replay.py, which checks the grid size and writes output.bin.
2. Once the bytes are written, sends Ctrl+Shift+F12 to that window, which
   this config binds to `write_screen_file:paste,plain`: Ghostty writes its
   screen (the scrollback and the active screen, soft wraps joined, no
   trimming of trailing spaces) to a file and pastes the path into the pty.
3. ghostty_replay.py copies the file to the fixture's ghostty-screen.txt and
   exits; the window closes.
"""

import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CLASS = "com.herdrfleet.vtcheck"
KEYS = ("CTRL SHIFT", "F12")


def ghostty_version() -> str:
    out = subprocess.run(["ghostty", "--version"], capture_output=True, text=True).stdout
    return out.splitlines()[0]


def hypr(lua: str) -> None:
    # exec_cmd returns nil, so `hyprctl dispatch` reports "expected a
    # dispatcher" after it has run the command; that message is not an error.
    subprocess.run(["hyprctl", "dispatch", lua], capture_output=True, check=False)


def wait_for(path: str, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if os.path.exists(path):
            return True
        time.sleep(0.1)
    return False


def capture(fixture: str) -> None:
    with open(os.path.join(fixture, "size.txt")) as f:
        cols, rows = (int(v) for v in f.read().strip().split("x"))
    rec = os.path.abspath(os.path.join(fixture, "output.bin"))
    work = tempfile.mkdtemp(prefix="vtcheck-")
    try:
        args = [
            "ghostty",
            "--gtk-single-instance=false",
            "--config-default-files=false",
            f"--class={CLASS}",
            "--window-decoration=none",
            "--window-padding-x=0",
            "--window-padding-y=0",
            "--window-padding-balance=false",
            f"--window-width={cols}",
            f"--window-height={rows}",
            "--confirm-close-surface=false",
            "--keybind=ctrl+shift+f12=write_screen_file:paste,plain",
            "-e",
            "python3",
            "-I",
            os.path.join(HERE, "ghostty_replay.py"),
            rec,
            str(cols),
            str(rows),
            work,
        ]
        cmd = shlex.join(args)
        hypr(f"hl.exec_cmd([==[{cmd}]==], {{ float = true }})")

        if not wait_for(os.path.join(work, "written"), 20):
            grid = read(os.path.join(work, "grid.txt"))
            sys.exit(f"{fixture}: bytes not written (grid {grid or 'unknown'}, want {cols}x{rows})")
        time.sleep(1.0)  # let Ghostty's IO thread parse everything
        hypr(
            "hl.dispatch(hl.dsp.send_shortcut({ "
            f'mods = "{KEYS[0]}", key = "{KEYS[1]}", window = "class:^({CLASS})$" }}))'
        )
        screen = os.path.join(work, "ghostty-screen.txt")
        if not wait_for(screen, 20):
            sys.exit(f"{fixture}: Ghostty did not write the screen")
        shutil.copyfile(screen, os.path.join(fixture, "ghostty-screen.txt"))
        print(f"{fixture}: {cols}x{rows} -> ghostty-screen.txt ({os.path.getsize(screen)} bytes)")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    print(ghostty_version())
    for fixture in sys.argv[1:]:
        capture(fixture)


if __name__ == "__main__":
    main()
