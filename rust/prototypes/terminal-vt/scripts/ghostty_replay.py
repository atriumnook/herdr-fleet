#!/usr/bin/env python3
"""Run inside a Ghostty window by capture_ghostty.py; not meant to be run by hand.

Usage: ghostty_replay.py <output.bin> <cols> <rows> <work dir>

1. Checks that the terminal is <cols> x <rows>; writes the size it found to
   <work dir>/grid.txt and stops without drawing anything if it differs.
2. Puts the tty in raw mode (no output processing, so a lone "\\n" stays
   "\\n" as it was when recorded; no echo) and writes output.bin unchanged.
3. Touches <work dir>/written, then reads its input until Ghostty pastes the
   path of the file its `write_screen_file:paste,plain` action wrote. The
   recorded programs' queries (DA, DSR, OSC 10/11) make Ghostty send replies
   before the path, so the path is found by pattern, not by position.
4. Copies that file to <work dir>/ghostty-screen.txt, removes Ghostty's
   temporary file, and exits, which closes the window.
"""

import os
import re
import select
import shutil
import sys
import termios
import time
import tty

PATH_RE = re.compile(rb"/[^\x00-\x1f\x7f]+?\.txt")


def main() -> None:
    rec, cols, rows, work = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    size = os.get_terminal_size(1)
    with open(os.path.join(work, "grid.txt"), "w") as f:
        f.write(f"{size.columns}x{size.lines}\n")
    if (size.columns, size.lines) != (cols, rows):
        sys.exit(1)

    old = termios.tcgetattr(0)
    tty.setraw(0)
    try:
        with open(rec, "rb") as f:
            data = f.read()
        view = memoryview(data)
        while view:
            n = os.write(1, view)
            view = view[n:]
        open(os.path.join(work, "written"), "w").close()

        received = b""
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            ready, _, _ = select.select([0], [], [], 0.5)
            if ready:
                received += os.read(0, 4096)
            for m in PATH_RE.finditer(received):
                path = m.group().decode("utf-8", "replace")
                if os.path.isfile(path):
                    # Ghostty writes and closes the file before it pastes the path.
                    # Copy, then rename: capture_ghostty.py waits for the final name.
                    partial = os.path.join(work, "ghostty-screen.txt.partial")
                    shutil.copyfile(path, partial)
                    os.rename(partial, os.path.join(work, "ghostty-screen.txt"))
                    os.remove(path)
                    try:
                        os.rmdir(os.path.dirname(path))
                    except OSError:
                        pass
                    return
        sys.exit(2)
    finally:
        termios.tcsetattr(0, termios.TCSANOW, old)


if __name__ == "__main__":
    main()
