import { describe, expect, it } from "bun:test";
import type { AgentRun } from "../../shared/fleet.ts";
import { fleetScreenModel, meterLevel, needsCount } from "./fleetView.ts";
import { INITIAL_STATE, type UiState } from "./state.ts";

const NOW = 1_000_000;
const run = (id: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  id, name: id, role: "worker", agent: "pi", group: "g1", herdrName: `h-${id}`, paneId: `w1:${id}`, cwd: "/w",
  state: "working", depth: 1, interactive: false, worktree: false, startedAt: 1, updatedAt: 1, ...extra,
});
const withRuns = (runs: AgentRun[], extra: Partial<UiState> = {}): UiState => ({ ...INITIAL_STATE, runs: { status: "ready", data: runs, again: false }, ...extra });

describe("fleet screen model", () => {
  it("orders runs by what they ask of the person, and folds ended ones away", () => {
    const model = fleetScreenModel(withRuns([
      run("done", { state: "done", updatedAt: 5 }),
      run("child", { depth: 2, startedAt: 3 }),
      run("waiting", { state: "blocked", lastError: "Cursor Agent asks whether to trust this folder." }),
      run("parent", { startedAt: 2 }),
      run("broken", { state: "failed", lastError: "rate limit exceeded", replacedBy: "parent" }),
      run("gone", { state: "stopped" }),
    ]), NOW);
    expect(model.sections.map((section) => [section.tone, section.runs.map((r) => r.id)])).toEqual([
      ["needs", ["waiting"]], ["failed", ["broken"]], ["working", ["parent", "child"]], ["done", ["done"]],
    ]);
    expect(model.ended.map((r) => r.id)).toEqual(["gone"]);
    expect(model.counts).toEqual({ needs: 1, failed: 1, working: 2, done: 1 });
    expect(model.sections[0]!.runs[0]!.question).toBe("Cursor Agent asks whether to trust this folder.");
    expect(model.sections[1]!.runs[0]).toMatchObject({ error: "rate limit exceeded", replacedBy: { id: "parent", name: "parent" } });
  });

  it("offers a pane only while it exists, and an interrupt only to a run that works or waits", () => {
    const model = fleetScreenModel(withRuns([run("w"), run("b", { state: "blocked" }), run("d", { state: "done" }), run("s", { state: "stopped" })]), NOW);
    const all = [...model.sections.flatMap((section) => section.runs), ...model.ended];
    const by = (id: string) => all.find((r) => r.id === id)!;
    expect([by("w"), by("b"), by("d"), by("s")].map((r) => [r.canOpenPane, r.canInterrupt])).toEqual([[true, true], [true, true], [true, false], [false, false]]);
  });

  it("names the groups whose finished non-interactive panes can be closed", () => {
    const model = fleetScreenModel(withRuns([run("a", { state: "done", group: "g2" }), run("b", { state: "done", interactive: true }), run("c", { state: "idle" })]), NOW);
    expect(model.closableGroups).toEqual(["g2"]);
  });

  it("shows each account's tightest window that has not reset, its cooldown while it lasts, and what is in flight", () => {
    const state: UiState = {
      ...withRuns([]),
      usage: { status: "ready", again: false, refreshing: false, data: [
        { key: "codex", reading: { readAt: 5, windows: [{ name: "5h", usedPercent: 92, resetsAt: NOW - 1 }, { name: "weekly", usedPercent: 64, resetsAt: NOW + 10 }] } },
        { key: "cursor", cooldown: { until: NOW + 60_000, reason: "rate limit", since: 1 } },
        { key: "agy:gemini", cooldown: { until: NOW - 1, reason: "over", since: 1 }, error: "agy exited with 1" },
      ] },
      request: { status: "pending", action: { kind: "clear-cooldown", key: "cursor" } },
    };
    const capsules = fleetScreenModel(state, NOW).usage.capsules;
    expect(capsules.map((c) => c.key)).toEqual(["agy:gemini", "codex", "cursor"]);
    expect(capsules[1]).toMatchObject({ agent: "codex", worst: { name: "weekly", usedPercent: 64 }, level: "mid", readAt: 5 });
    expect(capsules[2]).toMatchObject({ agent: "cursor", cooldown: { until: NOW + 60_000, reason: "rate limit" }, busy: true });
    expect(capsules[0]).toMatchObject({ agent: "agy", cooldown: undefined, error: "agy exited with 1", worst: undefined });
  });

  it("opens the detail of the run chosen, and says what the last action's failure was", () => {
    const state = withRuns([run("a", { skipped: [{ candidate: "claude:sonnet", reason: "claude has used 92% of its 5h limit" }] })], {
      detail: "a", request: { status: "failed", action: { kind: "interrupt", runId: "a" }, message: "read_only" },
    });
    const model = fleetScreenModel(state, NOW);
    expect(model.detail).toMatchObject({ id: "a", skipped: [{ candidate: "claude:sonnet" }] });
    expect(model.requestError).toBe("read_only");
  });

  it("offers a watch-only device no button the server would refuse", () => {
    const state = withRuns([run("w"), run("d", { state: "done" })], { canAct: false, usage: { status: "ready", again: false, refreshing: false, data: [{ key: "cursor", cooldown: { until: NOW + 1, reason: "r", since: 1 } }] } });
    const model = fleetScreenModel(state, NOW);
    expect(model.canAct).toBe(false);
    expect(model.sections.flatMap((s) => s.runs).map((r) => [r.canInterrupt, r.canOpenPane])).toEqual([[false, true], [false, true]]);
    expect(model.closableGroups).toEqual([]);
    expect(model.usage.capsules[0]!.canClear).toBe(false);
  });

  it("counts the runs waiting on the person for the Fleet button", () => {
    expect(needsCount(withRuns([run("a", { state: "blocked" }), run("b"), run("c", { state: "blocked" })]))).toBe(2);
  });

  it("meters by what is left: plenty from half, getting low from a fifth, low under it", () => {
    expect([0, 49, 50, 79, 80, 100].map(meterLevel)).toEqual(["ok", "ok", "mid", "mid", "low", "low"]);
  });
});
