import { describe, expect, it } from "bun:test";
import { contractItems, handoffStatus, threadState, type AgentRun, type AgentState } from "./fleet.ts";

describe("a thread's state", () => {
  const run = (state: AgentState, result?: string, extra: Partial<AgentRun> = {}) => ({ state, result, ...extra }) as AgentRun;

  it("follows its lead, and once a turn settled, the HANDOFF's verdict", () => {
    expect(threadState(run("starting"))).toBe("working");
    expect(threadState(run("working", "BLOCKED — an earlier turn's"))).toBe("working");
    expect(threadState(run("blocked"))).toBe("waiting");
    expect(threadState(run("idle", "BLOCKED — which one?"))).toBe("waiting");
    expect(threadState(run("idle", "## HANDOFF\n**PASS** — 12 pass"))).toBe("review");
    expect(threadState(run("done", "ISSUES — 2 fail"))).toBe("idle");
    expect(threadState(run("idle"))).toBe("idle");
    expect(threadState(run("failed", "PASS — 12 pass"))).toBe("failed");
    expect(threadState(run("stopped", "PASS — 12 pass"))).toBe("ended");
  });

  it("is resolved once the person marks it so, unless its lead works", () => {
    expect(threadState(run("idle", "PASS", { resolvedAt: 1 }))).toBe("resolved");
    expect(threadState(run("stopped", undefined, { resolvedAt: 1 }))).toBe("resolved");
    expect(threadState(run("working", undefined, { resolvedAt: 1 }))).toBe("working");
  });
});

describe("a HANDOFF's status line and a contract", () => {
  it("reads the first PASS, ISSUES or BLOCKED line without its markdown", () => {
    expect(handoffStatus("## HANDOFF\n> **ISSUES** — 2 fail\nPASS later")).toBe("ISSUES — 2 fail");
    expect(handoffStatus("nothing here")).toBeUndefined();
  });

  it("reads each assertion's mark", () => {
    expect(contractItems("- [x] A1 a\n- [ ] A2 b\n* [!] A3 c\n- [X] A4 d\nA5 loose")).toEqual([
      { id: "A1", state: "met" }, { id: "A2", state: "open" }, { id: "A3", state: "unmet" }, { id: "A4", state: "met" },
    ]);
  });
});
