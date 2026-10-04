import { describe, expect, it } from "bun:test";
import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import { relay, type Emit } from "./bubble.ts";
import { INITIAL_STATE, transition, type UiEvent, type UiState } from "./state.ts";

const run = (id: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  id, name: id, role: "worker", agent: "pi", group: "g1", herdrName: `h-${id}`, paneId: `w1:${id}`, cwd: "/w",
  state: "working", depth: 1, interactive: false, worktree: false, startedAt: 1, updatedAt: 1, ...extra,
});
const usage: UsageEntry[] = [{ key: "codex", reading: { readAt: 1, windows: [{ name: "5h", usedPercent: 12 }] } }];

/** Feeds events in order and collects every effect asked for. */
function play(events: UiEvent[], from: UiState = INITIAL_STATE) {
  let state = from;
  const effects = [];
  for (const event of events) {
    const result = transition(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

describe("loading runs and usage", () => {
  it("fetches both on the first fleet-changed (the event stream opening), and settles each with what came back", () => {
    const { state, effects } = play([{ type: "fleet-changed" }, { type: "runs-loaded", runs: [run("a")] }, { type: "usage-loaded", entries: usage }]);
    expect(effects).toEqual([{ kind: "load-runs" }, { kind: "load-usage" }]);
    expect(state.runs).toEqual({ status: "ready", data: [run("a")], again: false, error: undefined });
    expect(state.usage.status).toBe("ready");
  });

  it("fetches once more after the fetch in flight when a fleet-changed arrives meanwhile", () => {
    const loading = play([{ type: "fleet-changed" }]).state;
    const { state, effects } = play([{ type: "fleet-changed" }, { type: "fleet-changed" }], loading);
    expect(effects).toEqual([]);
    expect(state.runs.again).toBe(true);
    const settled = transition(state, { type: "runs-loaded", runs: [run("a")] });
    expect(settled.effects).toEqual([{ kind: "load-runs" }]);
    expect(settled.state.runs).toMatchObject({ status: "loading", data: [run("a")], again: false });
  });

  it("keeps the runs shown last when a fetch fails, with the error", () => {
    const { state } = play([{ type: "fleet-changed" }, { type: "runs-loaded", runs: [run("a")] }, { type: "fleet-changed" }, { type: "runs-failed", message: "offline" }]);
    expect(state.runs).toMatchObject({ status: "error", data: [run("a")], error: "offline" });
  });

  it("asks the CLIs again only once at a time, and a fleet-changed meanwhile waits for that answer", () => {
    const ready = play([{ type: "fleet-changed" }, { type: "runs-loaded", runs: [] }, { type: "usage-loaded", entries: [] }]).state;
    const { state, effects } = play([{ type: "refresh-usage" }, { type: "refresh-usage" }, { type: "fleet-changed" }], ready);
    expect(effects).toEqual([{ kind: "refresh-usage" }, { kind: "load-runs" }]);
    expect(state.usage.refreshing).toBe(true);
    expect(transition(state, { type: "usage-refreshed", entries: usage }).state.usage).toMatchObject({ refreshing: false, status: "ready", data: usage });
  });

  it("keeps a refresh going until its own answer, and reads again after it when a read was in flight", () => {
    const ready = play([{ type: "fleet-changed" }, { type: "runs-loaded", runs: [] }, { type: "usage-loaded", entries: [] }]).state;
    // a read starts, then the person refreshes: the read answering first does not end the refresh
    const reading = play([{ type: "fleet-changed" }, { type: "runs-loaded", runs: [] }, { type: "refresh-usage" }], ready).state;
    const readFirst = transition(reading, { type: "usage-loaded", entries: [] }).state;
    expect(readFirst.usage.refreshing).toBe(true);
    expect(transition(readFirst, { type: "refresh-usage" }).effects).toEqual([]);
    // the refresh answering while a read is in flight: that read may predate it, so another follows
    const refreshedFirst = transition(reading, { type: "usage-refreshed", entries: usage });
    expect(refreshedFirst.state.usage).toMatchObject({ refreshing: false, data: usage, status: "loading", again: true });
    expect(transition(refreshedFirst.state, { type: "usage-loaded", entries: [] }).effects).toEqual([{ kind: "load-usage" }]);
    expect(play([{ type: "refresh-usage" }, { type: "usage-refresh-failed", message: "agy exited with 1" }], ready).state.usage).toMatchObject({ refreshing: false, status: "error", error: "agy exited with 1" });
  });
});

describe("screens and the detail sheet", () => {
  const withRuns = play([{ type: "fleet-changed" }, { type: "runs-loaded", runs: [run("a"), run("gone", { state: "stopped" })] }]).state;

  it("opens a run's detail, closes it when the run disappears, and leaves it on the way to a pane", () => {
    expect(play([{ type: "show-screen", screen: "fleet" }, { type: "show-run", runId: "a" }], withRuns).state).toMatchObject({ screen: "fleet", detail: "a" });
    expect(play([{ type: "show-run", runId: "nobody" }], withRuns).state.detail).toBeNull();
    expect(play([{ type: "show-run", runId: "a" }, { type: "runs-loaded", runs: [] }], withRuns).state.detail).toBeNull();
    expect(play([{ type: "show-screen", screen: "fleet" }, { type: "show-run", runId: "a" }, { type: "pane-selected" }], withRuns).state).toMatchObject({ screen: "pane", detail: null });
  });

  it("opens a live run's pane through the legacy shell, a new request each time, and not an ended run's", () => {
    const first = play([{ type: "show-screen", screen: "fleet" }, { type: "open-pane", runId: "a" }], withRuns).state;
    expect(first).toMatchObject({ screen: "pane", paneRequest: { paneId: "w1:a", seq: 1 } });
    expect(transition(first, { type: "open-pane", runId: "a" }).state.paneRequest).toEqual({ paneId: "w1:a", seq: 2 });
    expect(play([{ type: "show-screen", screen: "fleet" }, { type: "open-pane", runId: "gone" }], withRuns).state).toMatchObject({ screen: "fleet", paneRequest: null });
  });
});

describe("actions", () => {
  it("runs one action at a time and forgets it once done", () => {
    const { state, effects } = play([{ type: "interrupt-run", runId: "a" }, { type: "close-done", group: "g1" }]);
    expect(effects).toEqual([{ kind: "request", action: { kind: "interrupt", runId: "a" } }]);
    expect(state.request).toEqual({ status: "pending", action: { kind: "interrupt", runId: "a" } });
    expect(transition(state, { type: "request-done" }).state.request).toEqual({ status: "none" });
  });

  it("reads the usage again after clearing a cooldown, which no fleet-changed follows", () => {
    const ready = play([{ type: "fleet-changed" }, { type: "runs-loaded", runs: [] }, { type: "usage-loaded", entries: usage }]).state;
    const { effects } = play([{ type: "clear-cooldown", key: "cursor" }, { type: "request-done" }], ready);
    expect(effects).toEqual([{ kind: "request", action: { kind: "clear-cooldown", key: "cursor" } }, { kind: "load-usage" }]);
  });

  it("keeps a failed action's message until it is dismissed", () => {
    const failed = play([{ type: "close-done", group: "g1" }, { type: "request-failed", message: "read_only" }]).state;
    expect(failed.request).toEqual({ status: "failed", action: { kind: "close-done", group: "g1" }, message: "read_only" });
    expect(transition(failed, { type: "dismiss-error" }).state.request).toEqual({ status: "none" });
    // an outcome with nothing pending changes nothing
    expect(transition(INITIAL_STATE, { type: "request-done" }).state).toBe(INITIAL_STATE);
  });
});

describe("a watch-only device", () => {
  it("changes nothing: no action and no refresh leave it", () => {
    const watching = transition(INITIAL_STATE, { type: "access-known", canAct: false }).state;
    for (const event of [{ type: "interrupt-run", runId: "a" }, { type: "close-done", group: "g1" }, { type: "clear-cooldown", key: "cursor" }, { type: "refresh-usage" }] as UiEvent[]) {
      expect(transition(watching, event)).toEqual({ state: watching, effects: [] });
    }
  });
});

describe("bubbling", () => {
  it("lets each parent add what it knows, or stop the event", () => {
    const received: unknown[] = [];
    const root: Emit<{ type: string; runId?: string; group?: string }> = (event) => received.push(event);
    const group = relay<{ type: string; runId?: string }, { type: string; runId?: string; group?: string }>(root, (event, pass) => pass({ ...event, group: "g1" }));
    const row = relay<{ type: string }, { type: string; runId?: string }>(group, (event, pass) => { if (event.type !== "hover") pass({ ...event, runId: "a" }); });
    row({ type: "open-pane" });
    row({ type: "hover" });
    expect(received).toEqual([{ type: "open-pane", runId: "a", group: "g1" }]);
  });
});
