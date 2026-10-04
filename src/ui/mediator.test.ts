import { describe, expect, it } from "bun:test";
import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import { Mediator, type EffectPorts } from "./mediator.ts";
import type { RequestAction } from "./state.ts";

const run: AgentRun = { id: "a", name: "impl", role: "worker", agent: "pi", group: "g1", herdrName: "h", paneId: "w1:p1", cwd: "/w", state: "working", depth: 1, interactive: false, worktree: false, startedAt: 1, updatedAt: 1 };
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(2); expect(check()).toBe(true); };

function ports(overrides: Partial<EffectPorts> = {}) {
  const requests: RequestAction[] = [];
  const base: EffectPorts = {
    loadRuns: async () => [run],
    loadUsage: async (): Promise<UsageEntry[]> => [],
    refreshUsage: async (): Promise<UsageEntry[]> => [{ key: "codex" }],
    runRequest: async (action) => { requests.push(action); },
  };
  return { ports: { ...base, ...overrides }, requests };
}

describe("Mediator", () => {
  it("runs the effects the state machine asks for and feeds their outcome back", async () => {
    const { ports: p } = ports();
    const mediator = new Mediator(p);
    let notified = 0;
    mediator.subscribe(() => { notified += 1; });
    mediator.dispatch({ type: "started" });
    await until(() => mediator.getState().runs.status === "ready" && mediator.getState().usage.status === "ready");
    expect(mediator.getState().runs.data).toEqual([run]);
    expect(notified).toBeGreaterThanOrEqual(3);
  });

  it("turns a failed effect into a failure event with its message", async () => {
    const { ports: p } = ports({ loadRuns: async () => { throw new Error("/api/fleet/runs failed (401): unauthorized"); } });
    const mediator = new Mediator(p);
    mediator.dispatch({ type: "started" });
    await until(() => mediator.getState().runs.status === "error");
    expect(mediator.getState().runs.error).toContain("401");
  });

  it("sends an action to the server and clears it when the server answered", async () => {
    const { ports: p, requests } = ports();
    const mediator = new Mediator(p);
    mediator.dispatch({ type: "interrupt-run", runId: "a" });
    expect(mediator.getState().request.status).toBe("pending");
    await until(() => mediator.getState().request.status === "none");
    expect(requests).toEqual([{ kind: "interrupt", runId: "a" }]);
  });

  it("does not notify listeners when an event changes nothing", () => {
    const { ports: p } = ports();
    const mediator = new Mediator(p);
    let notified = 0;
    mediator.subscribe(() => { notified += 1; });
    mediator.dispatch({ type: "request-done" });
    expect(notified).toBe(0);
  });
});
