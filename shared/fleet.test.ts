import { describe, expect, it } from "bun:test";
import { contractItems, outcomeLine, threadState, type AgentRun, type AgentState, type ReportState } from "./fleet.ts";

describe("a thread's state", () => {
  /** a run whose last turn reported `report` ("none": its turn left no report; absent: a run from before reports) */
  const run = (state: AgentState, report?: ReportState | "none", extra: Partial<AgentRun> & { human_action?: string } = {}) => {
    const { human_action, ...rest } = extra;
    const outcome = report === undefined ? undefined : report === "none" ? { report: null, problem: "report.json is missing." }
      : { report: { state: report, summary: `${report} summary`, evidence: [], ...(human_action ? { human_action } : {}) } };
    return { state, ...(outcome ? { outcome } : {}), ...rest } as AgentRun;
  };

  it("follows its lead, and once a turn settled, its report: a person is needed only when the report says so, or there is none", () => {
    expect(threadState(run("starting"))).toBe("working");
    expect(threadState(run("working", "blocked"))).toBe("working");
    expect(threadState(run("blocked"))).toBe("waiting");
    expect(threadState(run("idle", "blocked"))).toBe("waiting");
    expect(threadState(run("idle", "failed"))).toBe("waiting");
    expect(threadState(run("idle", "progress", { human_action: "Which one?" }))).toBe("waiting");
    expect(threadState(run("idle", "none"))).toBe("waiting");
    expect(threadState(run("idle", "ready"))).toBe("review");
    for (const quiet of ["progress", "waiting", "dropped"] as const) expect(threadState(run("done", quiet))).toBe("idle");
    expect(threadState(run("idle"))).toBe("idle");
    expect(threadState(run("failed", "ready"))).toBe("failed");
    expect(threadState(run("stopped", "ready"))).toBe("ended");
  });

  it("is resolved once the person marks it so, unless its lead works", () => {
    expect(threadState(run("idle", "ready", { resolvedAt: 1 }))).toBe("resolved");
    expect(threadState(run("stopped", undefined, { resolvedAt: 1 }))).toBe("resolved");
    expect(threadState(run("working", undefined, { resolvedAt: 1 }))).toBe("working");
  });

  it("is landing while its pull request is open, and needs the person when its checks fail or a landing step went wrong", () => {
    const pr = { number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", checks: "pending" } as const;
    expect(threadState(run("idle", "ready", { pr }))).toBe("landing");
    expect(threadState(run("idle", "ready", { pr: { ...pr, checks: "fail", failing: ["test"] } }))).toBe("waiting");
    expect(threadState(run("idle", "ready", { pr: { ...pr, state: "CLOSED" } }))).toBe("review");
    expect(threadState(run("idle", "ready", { landing: { action: "merge", at: 1, sent: true, error: "not merged" } }))).toBe("waiting");
    expect(threadState(run("working", "ready", { pr: { ...pr, checks: "fail" } }))).toBe("working");
    expect(threadState(run("stopped", "ready", { pr: { ...pr, state: "MERGED" }, landed: "merged", resolvedAt: 1 }))).toBe("resolved");
  });
});

describe("a turn's outcome and a contract", () => {
  it("says a turn's outcome in a line: the report's state and summary, or that there is none and why", () => {
    expect(outcomeLine({ report: { state: "ready", summary: "12 pass.", evidence: [] } })).toBe("ready — 12 pass.");
    expect(outcomeLine({ report: null, problem: "report.json is missing." })).toBe("no report — report.json is missing.");
  });

  it("reads each assertion's mark", () => {
    expect(contractItems("- [x] A1 a\n- [ ] A2 b\n* [!] A3 c\n- [X] A4 d\nA5 loose")).toEqual([
      { id: "A1", state: "met" }, { id: "A2", state: "open" }, { id: "A3", state: "unmet" }, { id: "A4", state: "met" },
    ]);
  });
});
