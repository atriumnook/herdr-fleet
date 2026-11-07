#!/bin/sh
# Record every fixture's output.bin and size.txt again (see fixtures/README.md).
# Runs no model and types nothing into the programs; the agent CLIs start with
# an empty, private config folder, so they show their first-run screen and
# read none of the user's settings or sign-ins.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
fixtures=$(cd "$here/../fixtures" && pwd)
inputs="$here/inputs"
record="python3 -I $here/record.py"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Full-screen TUI on the alternate screen, with wide characters.
$record "$fixtures/nvim-japanese" 100 30 4 \
  "env XDG_STATE_HOME=$tmp/nvim-state XDG_CACHE_HOME=$tmp/nvim-cache nvim --clean -i NONE -n $inputs/japanese.txt"

# A pager on the alternate screen, showing 256-color and 24-bit SGR.
sh "$inputs/sgr.sh" >"$tmp/sgr.txt"
$record "$fixtures/less-sgr" 90 28 3 \
  "env LESSHISTFILE=- LESS= less -R $tmp/sgr.txt"

# 256-color and 24-bit SGR on the primary screen, partly in the scrollback.
$record "$fixtures/sgr-colors" 80 24 2 "sh $inputs/sgr.sh"

# Wide characters, combining marks, emoji and tabs on a narrow screen.
$record "$fixtures/wide-chars" 40 12 2 "sh $inputs/wide.sh"

# Soft wraps, a pending wrap, and the scrollback.
$record "$fixtures/scroll-wrap" 60 10 2 "sh $inputs/scroll.sh"

# Agent CLIs' first screens, in an empty folder with an empty config.
mkdir -p "$tmp/claude-config" "$tmp/claude-work"
$record "$fixtures/claude-startup" 100 30 8 \
  "cd $tmp/claude-work && env CLAUDE_CONFIG_DIR=$tmp/claude-config DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude"

mkdir -p "$tmp/codex-home" "$tmp/codex-work"
$record "$fixtures/codex-startup" 100 30 8 \
  "cd $tmp/codex-work && env CODEX_HOME=$tmp/codex-home codex"
