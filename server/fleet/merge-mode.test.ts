import { describe, expect, it } from "bun:test";
import type { MergeSetting } from "../../shared/fleet.ts";
import { checkMergeSetting, evaluateGate, mergeAuthority, type GateFacts } from "./merge-mode.ts";

const GATED: MergeSetting = { mode: "gated", branches: ["rust"], maxLines: 200, protected: ["docs/rust-migration/plan.md", "migrations/"] };
const HEAD_AT = 1_000_000;

/** a thread every condition of the gate holds for: written on claude, reviewed on codex after its last commit */
const passing = (): GateFacts => ({
  report: "ready",
  contract: [{ id: "A1", state: "met" }],
  writers: ["claude"],
  reviews: [{ agent: "codex", report: "ready", at: HEAD_AT + 60_000 }],
  headAt: HEAD_AT,
  pr: { state: "OPEN", checks: "pass" },
  lines: 200,
  files: ["src/parser.rs", "docs/rust-migration/notes.md"],
  behind: 0,
});

const gate = mergeAuthority(GATED, "rust");
if (gate.mode !== "gated") throw new Error("rust is gated");
const failed = (facts: GateFacts) => evaluateGate(gate, facts).checks.filter((check) => !check.ok).map((check) => check.id);

describe("merge authority", () => {
  it("is the person's unless the person's setting is gated and names the base branch", () => {
    expect(mergeAuthority(undefined, "main")).toEqual({ mode: "person" });
    expect(mergeAuthority(GATED, "main")).toEqual({ mode: "person" });
    expect(mergeAuthority({ ...GATED, mode: "person" }, "rust")).toEqual({ mode: "person" });
    expect(mergeAuthority({ ...GATED, branches: [] }, "rust")).toEqual({ mode: "person" });
    expect(mergeAuthority(GATED, "rust")).toEqual({ mode: "gated", maxLines: 200, protected: GATED.protected });
  });

  it("takes from the Settings page only a setting it can check", () => {
    expect(checkMergeSetting({ mode: "person", branches: ["x"] })).toEqual({ mode: "person", branches: [], maxLines: 200, protected: [] });
    expect(checkMergeSetting({ mode: "gated", branches: ["rust"] })).toEqual({ mode: "gated", branches: ["rust"], maxLines: 200, protected: [] });
    for (const bad of [{ mode: "auto" }, { mode: "gated" }, { mode: "gated", branches: ["a b"] }, { mode: "gated", branches: ["rust"], maxLines: 0 }, { mode: "gated", branches: ["rust"], protected: [""] }]) {
      expect(() => checkMergeSetting(bad)).toThrow();
    }
  });
});

describe("the merge gate", () => {
  it("holds when all six conditions hold", () => {
    expect(evaluateGate(gate, passing()).ok).toBe(true);
  });

  it("a) waits unless the lead's latest report is ready", () => {
    expect(failed({ ...passing(), report: "progress" })).toEqual(["report"]);
    expect(failed({ ...passing(), report: undefined })).toEqual(["report"]);
    // without checks on the pull request, the lead's recorded checks stand in for them: they need a ready report too
    expect(failed({ ...passing(), report: "blocked", pr: { state: "OPEN", checks: "none" } })).toEqual(["report", "checks"]);
  });

  it("b) waits unless a reviewer on a CLI none of the writers used passed after the latest commit", () => {
    // reviewed on the writer's own CLI
    expect(failed({ ...passing(), reviews: [{ agent: "claude", report: "ready", at: HEAD_AT + 1 }] })).toEqual(["review"]);
    // a lead run of the thread was restarted on codex: codex wrote too
    expect(failed({ ...passing(), writers: ["claude", "codex"] })).toEqual(["review"]);
    // the review found issues
    expect(failed({ ...passing(), reviews: [{ agent: "codex", report: "failed", at: HEAD_AT + 1 }] })).toEqual(["review"]);
    // the lead committed its fixes after the review: nobody reviewed them
    expect(failed({ ...passing(), reviews: [{ agent: "codex", report: "ready", at: HEAD_AT - 1 }] })).toEqual(["review"]);
    expect(failed({ ...passing(), headAt: null })).toEqual(["review"]);
    expect(failed({ ...passing(), reviews: [] })).toEqual(["review"]);
  });

  it("c) waits unless the pull request's checks passed, or it has none and the lead's contract is met", () => {
    expect(failed({ ...passing(), pr: { state: "OPEN", checks: "fail" } })).toEqual(["checks"]);
    expect(failed({ ...passing(), pr: { state: "OPEN", checks: "pending" } })).toEqual(["checks"]);
    expect(failed({ ...passing(), pr: undefined })).toEqual(["checks"]);
    expect(failed({ ...passing(), pr: { state: "OPEN", checks: "none" } })).toEqual([]);
    expect(failed({ ...passing(), pr: { state: "OPEN", checks: "none" }, contract: [{ id: "A1", state: "met" }, { id: "A2", state: "open" }] })).toEqual(["checks"]);
    expect(failed({ ...passing(), pr: { state: "OPEN", checks: "none" }, contract: [] })).toEqual(["checks"]);
  });

  it("d) waits when the change has more lines than the limit", () => {
    expect(failed({ ...passing(), lines: 201 })).toEqual(["size"]);
    expect(failed({ ...passing(), lines: null })).toEqual(["size"]);
  });

  it("e) waits when the change touches a path the person protects, or the gate itself, or the project's fleet files or CI", () => {
    for (const file of ["docs/rust-migration/plan.md", "migrations/001.sql", ".herdr-fleet/agents/lead.md", ".github/workflows/ci.yml", "server/fleet/merge-mode.ts", "server/access.ts", "agents/coordinator.md"]) {
      expect(failed({ ...passing(), files: ["src/a.rs", file] })).toEqual(["paths"]);
    }
    expect(failed({ ...passing(), files: null })).toEqual(["paths"]);
    expect(evaluateGate(gate, { ...passing(), files: [".github/workflows/ci.yml"] }).checks.find((check) => check.id === "paths")!.detail).toBe("It touches protected paths: .github/workflows/ci.yml.");
  });

  it("f) waits unless the branch has the base branch's latest commits", () => {
    expect(failed({ ...passing(), behind: 1 })).toEqual(["fresh"]);
    expect(failed({ ...passing(), behind: null })).toEqual(["fresh"]);
  });
});
