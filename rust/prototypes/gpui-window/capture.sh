#!/bin/bash
# Opens the prototype's window on Hyprland, records it with `hyprctl clients -j`,
# grabs only that window with `grim`, and closes it.
#
#   ./capture.sh <png> [<dir for client.json, maps.txt and run.log>]
#
# Run `cargo build` first. The window opens on the current workspace for about
# two seconds; it is floated and centered (a dispatch to this window only, no
# change to the Hyprland config) so notification overlays do not cover it.
# The dispatch syntax is the Lua one of Hyprland 0.56.
set -eu
png=$1
out=${2:-.}
cd "$(dirname "$0")"

env $(env | grep -oE '^HERDR[A-Z_]*' | sed 's/^/-u /') ./target/debug/gpui-window >"$out/run.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  hyprctl clients -j | jq -e --argjson p "$pid" 'any(.[]; .pid == $p)' >/dev/null && break
  sleep 0.2
done

w="window = \"pid:$pid\""
hyprctl dispatch "hl.dsp.window.float({ action = \"on\", $w })" >/dev/null
hyprctl dispatch "hl.dsp.window.resize({ x = 480, y = 240, $w })" >/dev/null
hyprctl dispatch "hl.dsp.window.center({ $w })" >/dev/null
sleep 1.5 # let it draw

hyprctl clients -j | jq --argjson p "$pid" \
  '.[] | select(.pid == $p) | {class, title, xwayland, pid, at, size, workspace: .workspace.name, floating}' \
  >"$out/client.json"
awk '{print $6}' "/proc/$pid/maps" | grep '\.so' | sort -u >"$out/maps.txt"
grim -g "$(jq -r '"\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"' "$out/client.json")" "$png"

kill "$pid"
wait "$pid" 2>/dev/null || true
trap - EXIT
sleep 0.5
echo "windows left: $(hyprctl clients -j | jq --argjson p "$pid" '[.[] | select(.pid == $p)] | length')"
echo "processes left: $(ps -p "$pid" -o pid= | wc -l)"
