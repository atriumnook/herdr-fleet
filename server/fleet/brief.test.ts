import { describe, expect, it } from "bun:test";
import { checkBrief, overlap, renderBrief, writeScope } from "./brief.ts";

const full = { goal: "Fix the retry.", write: ["src/retry.ts"], context: "none", done: "One notification per retry.", verify: "bun test src/retry.test.ts; paste the result." };

describe("brief", () => {
  it("names every missing field at once, and takes an empty write list as read-only work", () => {
    expect(() => checkBrief(undefined)).toThrow("missing: goal, write, context, done, verify");
    expect(() => checkBrief({ goal: "x", write: [], context: " ", done: "d" })).toThrow("missing: context, verify");
    expect(checkBrief({ ...full, write: [] }).write).toEqual([]);
  });

  it("turns into the helper's task, with what it may change and when to stop", () => {
    const task = renderBrief({ ...full, timebox: "20 minutes" }, "Prefer the existing queue.");
    expect(task).toContain("## Goal\n\nFix the retry.");
    expect(task).toContain("- src/retry.ts\nChange nothing outside these paths.");
    expect(task).toContain("## Done when\n\nOne notification per retry.");
    expect(task).toContain("20 minutes. When it runs out, report what you have and stop.");
    expect(task).toContain("## Notes\n\nPrefer the existing queue.");
    expect(task).not.toContain("## Forbidden");
    expect(renderBrief({ ...full, write: [] })).toContain("Nothing: this task only reads.");
  });

  it("finds a path held twice: the same one, or one inside the other, but not a sibling", () => {
    const a = writeScope("/repo", ["src/retry.ts", "docs"]);
    expect(overlap(a, writeScope("/repo", ["./src/retry.ts"]))).toEqual({ mine: "/repo/src/retry.ts", theirs: "/repo/src/retry.ts" });
    expect(overlap(a, writeScope("/repo", ["docs/guide.md"]))).toEqual({ mine: "/repo/docs", theirs: "/repo/docs/guide.md" });
    expect(overlap(a, writeScope("/repo", ["."]))).toBeDefined();
    expect(overlap(a, writeScope("/repo", ["src/retry.test.ts", "docs-old"]))).toBeUndefined();
    expect(overlap(a, writeScope("/other", ["src/retry.ts"]))).toBeUndefined();
  });
});
