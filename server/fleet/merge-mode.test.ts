import { describe, expect, it } from "bun:test";
import type { MergeSetting } from "../../shared/fleet.ts";
import { checkMergeSetting, evaluateGate, mergeAuthority, type GateFacts } from "./merge-mode.ts";

const GATED: MergeSetting = { mode: "gated", branches: ["rust"], maxLines: 200, protected: ["docs/rust-migration/plan.md", "migrations/"] };

/** a thread every condition of the gate holds for: written on claude, reviewed on codex at its latest commit */
const passing = (): GateFacts => ({
  report: "ready",
  contract: [{ id: "A1", state: "met" }],
  writers: ["claude"],
  reviews: [{ agent: "codex", report: "ready", head: "c0ffee" }],
  head: "c0ffee",
  base: "rust",
  pr: { state: "OPEN", checks: "pass", head: "c0ffee", base: "rust", checksRead: true },
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
    expect(failed({ ...passing(), report: "blocked", pr: { state: "OPEN", checks: "none", head: "c0ffee", base: "rust", checksRead: true } })).toEqual(["report", "checks"]);
  });

  it("b) waits unless a reviewer on a CLI none of the writers used passed at the branch's latest commit", () => {
    // reviewed on the writer's own CLI
    expect(failed({ ...passing(), reviews: [{ agent: "claude", report: "ready", head: "c0ffee" }] })).toEqual(["review"]);
    // a lead run of the thread was restarted on codex, or codex edited as a helper: codex wrote too
    expect(failed({ ...passing(), writers: ["claude", "codex"] })).toEqual(["review"]);
    // the review found issues
    expect(failed({ ...passing(), reviews: [{ agent: "codex", report: "failed", head: "c0ffee" }] })).toEqual(["review"]);
    // the lead committed its fixes after the review, whatever date the commit says: nobody reviewed them
    expect(failed({ ...passing(), reviews: [{ agent: "codex", report: "ready", head: "older" }] })).toEqual(["review"]);
    expect(failed({ ...passing(), reviews: [{ agent: "codex", report: "ready" }] })).toEqual(["review"]);
    expect(failed({ ...passing(), head: null })).toEqual(["review", "checks"]);
    expect(failed({ ...passing(), reviews: [] })).toEqual(["review"]);
  });

  it("c) waits unless the pull request's checks passed, or it has none and the lead's contract is met", () => {
    const pr = (checks: "pass" | "fail" | "pending" | "none") => ({ state: "OPEN" as const, checks, head: "c0ffee", base: "rust", checksRead: true });
    expect(failed({ ...passing(), pr: pr("fail") })).toEqual(["checks"]);
    expect(failed({ ...passing(), pr: pr("pending") })).toEqual(["checks"]);
    expect(failed({ ...passing(), pr: undefined })).toEqual(["checks"]);
    expect(failed({ ...passing(), pr: pr("none") })).toEqual([]);
    expect(failed({ ...passing(), pr: pr("none"), contract: [{ id: "A1", state: "met" }, { id: "A2", state: "open" }] })).toEqual(["checks"]);
    expect(failed({ ...passing(), pr: pr("none"), contract: [] })).toEqual(["checks"]);
    // the lead committed after pushing: what was measured here is not what the merge takes
    expect(failed({ ...passing(), pr: { ...pr("pass"), head: "older" } })).toEqual(["checks"]);
    // GitHub could not be asked about the checks: that is not a pull request without checks
    expect(failed({ ...passing(), pr: { ...pr("none"), checksRead: false } })).toEqual(["checks"]);
    // the pull request targets a branch the gate does not cover, whatever the thread started from
    expect(evaluateGate(gate, { ...passing(), pr: { ...pr("pass"), base: "main" } }).checks.find((check) => check.id === "checks")).toEqual({ id: "checks", ok: false, detail: "The pull request targets main, not rust." });
  });

  it("d) waits when the change has more lines than the limit", () => {
    expect(failed({ ...passing(), lines: 201 })).toEqual(["size"]);
    expect(failed({ ...passing(), lines: null })).toEqual(["size"]);
  });

  it("e) waits when the change touches a path the person protects, or the gate itself, or the project's fleet files or CI", () => {
    for (const file of [
      "docs/rust-migration/plan.md", "migrations/001.sql", "migrations", ".herdr-fleet/agents/lead.md", ".github/workflows/ci.yml",
      // a symlink in a protected folder's place is a change to that folder
      ".herdr-fleet", ".github",
      "server/fleet/merge-mode.ts", "server/fleet/orchestrator.ts", "server/fleet/config.ts", "server/fleet/settings.ts", "server/access.ts", "agents/coordinator.md", "agents/lead.md", "opencode/fleet-guard/guard.js",
    ]) {
      expect(failed({ ...passing(), files: ["src/a.rs", file] })).toEqual(["paths"]);
    }
    expect(failed({ ...passing(), files: null })).toEqual(["paths"]);
    expect(failed({ ...passing(), files: [".githubx/notes.md", "src/.github.rs"] })).toEqual([]);
    expect(evaluateGate(gate, { ...passing(), files: [".github/workflows/ci.yml"] }).checks.find((check) => check.id === "paths")!.detail).toBe("It touches protected paths: .github/workflows/ci.yml.");
  });

  it("f) waits unless the branch has the base branch's latest commits", () => {
    expect(failed({ ...passing(), behind: 1 })).toEqual(["fresh"]);
    expect(failed({ ...passing(), behind: null })).toEqual(["fresh"]);
  });
});
