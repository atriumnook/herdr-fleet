#!/bin/sh
# Lines longer than the screen (soft wraps), a line exactly as wide as the
# screen (pending wrap), and enough output to fill the scrollback.
seq 1 30
printf 'x%.0s' $(seq 1 60); printf '\n'
printf 'y%.0s' $(seq 1 150); printf '\n'
printf 'z%.0s' $(seq 1 60)
printf '\r\nafter pending wrap\n'
printf '\033[3;1Hoverwritten row 3\033[K'
printf '\033[10;1H'
