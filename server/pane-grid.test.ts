import { expect, it } from "bun:test";
import { controllingPts, parseSttySize } from "./pane-grid.ts";

it("reads stty's rows-then-columns as a grid", () => {
  expect(parseSttySize("40 211\n")).toEqual({ cols: 211, rows: 40 });
});

it("takes no grid from an empty or zero-sized answer", () => {
  expect(parseSttySize("")).toBeNull();
  expect(parseSttySize("0 0\n")).toBeNull();
  expect(parseSttySize("stty: /dev/pts/9: No such file or directory\n")).toBeNull();
});

it("names the pty a process has as its controlling terminal, whatever its command is called", () => {
  // tty_nr 34834 is major 136, minor 18
  expect(controllingPts("369640 (zsh) S 369600 369640 369640 34834 369700 4194560 1200 0 0 0")).toBe("/dev/pts/18");
  expect(controllingPts("12 (odd) name (x)) S 1 12 12 34834 12 0")).toBe("/dev/pts/18");
  // major 137 continues the numbering past 255
  expect(controllingPts("12 (zsh) S 1 12 12 35116 12 0")).toBe("/dev/pts/300");
});

it("names no pty for a process with no terminal, or one that is not a pty", () => {
  expect(controllingPts("12 (daemon) S 1 12 12 0 -1 0")).toBeNull();
  // 1025 is major 4, a virtual console
  expect(controllingPts("12 (getty) S 1 12 12 1025 12 0")).toBeNull();
  expect(controllingPts("")).toBeNull();
});
