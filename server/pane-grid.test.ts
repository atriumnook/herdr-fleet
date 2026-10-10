import { expect, it } from "bun:test";
import { parseSttySize } from "./pane-grid.ts";

it("reads stty's rows-then-columns as a grid", () => {
  expect(parseSttySize("40 211\n")).toEqual({ cols: 211, rows: 40 });
});

it("takes no grid from an empty or zero-sized answer", () => {
  expect(parseSttySize("")).toBeNull();
  expect(parseSttySize("0 0\n")).toBeNull();
  expect(parseSttySize("stty: /dev/pts/9: No such file or directory\n")).toBeNull();
});
