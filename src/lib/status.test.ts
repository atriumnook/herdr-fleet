import { describe, expect, it } from "bun:test";

import { statusEdgeRead } from "./status.ts";

describe("statusEdgeRead", () => {
  it("reads at once when a turn starts or ends", () => {
    expect(statusEdgeRead("working", "done")).toBe(true);
    expect(statusEdgeRead("working", "idle")).toBe(true);
    expect(statusEdgeRead("working", "blocked")).toBe(true);
    expect(statusEdgeRead("idle", "working")).toBe(true);
    expect(statusEdgeRead("done", "working")).toBe(true);
    expect(statusEdgeRead(undefined, "working")).toBe(true);
  });

  it("leaves an unchanged status and changes that neither start nor end a turn to the poll", () => {
    expect(statusEdgeRead("working", "working")).toBe(false);
    expect(statusEdgeRead("idle", "idle")).toBe(false);
    expect(statusEdgeRead("idle", "done")).toBe(false);
    expect(statusEdgeRead("blocked", "idle")).toBe(false);
    expect(statusEdgeRead(undefined, undefined)).toBe(false);
  });
});
