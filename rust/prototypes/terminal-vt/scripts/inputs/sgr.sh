#!/bin/sh
# 256-color and 24-bit SGR, printed on the primary screen (more lines than
# the screen has rows, so part of it goes to the scrollback).
i=0
while [ $i -lt 256 ]; do
  printf '\033[38;5;%dm%3d\033[0m ' "$i" "$i"
  i=$((i + 1))
  [ $((i % 16)) -eq 0 ] && printf '\n'
done
i=0
while [ $i -lt 16 ]; do
  printf '\033[48;5;%dm  \033[0m' "$i"
  i=$((i + 1))
done
printf '\n'
r=0
while [ $r -lt 8 ]; do
  c=0
  while [ $c -lt 32 ]; do
    printf '\033[38;2;%d;%d;%dm\033[48;2;%d;%d;%dm#' $((c * 8)) $((r * 32)) $((255 - c * 8)) $((r * 16)) 0 $((c * 4))
    c=$((c + 1))
  done
  printf '\033[0m row %d\n' "$r"
  r=$((r + 1))
done
printf '\033[1;3;4;38;2;255;128;0mbold italic underline orange\033[0m \033[7mreverse\033[27m \033[9mstrike\033[0m\n'
printf '\033[4:3;58;2;0;255;0mcurly green underline\033[0m \033[38:2::10:20:30mcolon form\033[0m\n'
