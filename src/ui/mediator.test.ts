import { describe, expect, it } from "bun:test";
import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import type { PairedDevice, RemoteAccess } from "../../shared/protocol.ts";
import type { Settings } from "../lib/settings.ts";
import { Mediator, type EffectPorts } from "./mediator.ts";
import type { RequestAction } from "./state.ts";

const run: AgentRun = { id: "a", name: "impl", role: "worker", agent: "pi", group: "g1", herdrName: "h", paneId: "w1:p1", cwd: "/w", state: "working", depth: 1, interactive: false, worktree: false, startedAt: 1, updatedAt: 1 };
const access: RemoteAccess = { port: 7000, tailscale: { state: "running", dns_name: "pc.tail.ts.net", serving_url: "https://pc.tail.ts.net", serve_command: null, serve_url: null } };
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(2); expect(check()).toBe(true); };

function ports(overrides: Partial<EffectPorts> = {}) {
  const requests: RequestAction[] = [];
  const saved: Settings[] = [];
  const forgotten: number[] = [];
  const timers: Array<{ ms: number; then: () => void }> = [];
  const base: EffectPorts = {
    loadRuns: async () => [run],
    loadUsage: async (): Promise<UsageEntry[]> => [],
    refreshUsage: async (): Promise<UsageEntry[]> => [{ key: "codex" }],
    runRequest: async (action) => { requests.push(action); },
    saveSettings: (settings) => { saved.push(settings); },
    forgetPaneViews: () => { forgotten.push(1); },
    loadRemoteAccess: async (): Promise<RemoteAccess> => access,
    loadDevices: async (): Promise<PairedDevice[] | null> => [],
    startPairing: async () => ({ code: "123456", expires_at: new Date(Date.now() + 600_000).toISOString() }),
    renameDevice: async () => {},
    revokeDevice: async () => {},
    later: (ms, then) => { timers.push({ ms, then }); },
    testPush: async () => "sent",
    storeSelection: () => {},
    treeRequest: async () => {},
    loadAccess: async () => ({ ok: true, auth: { required: false, authenticated: true, via: "local" }, bridge_protocol: 1 }),
    loadHealth: async () => ({ ok: true }) as never,
    loadMachines: async () => [],
    authenticate: async () => {},
    pairFromAddress: async () => {},
    signOut: async () => {},
    loadSession: async () => { throw new Error("no session"); },
    openStream: () => () => {},
    storeLens: () => {},
  };
  return { ports: { ...base, ...overrides }, requests, saved, forgotten, timers };
}

describe("Mediator", () => {
  it("runs the effects the state machine asks for and feeds their outcome back", async () => {
    const { ports: p } = ports();
    const mediator = new Mediator(p);
    let notified = 0;
    mediator.subscribe(() => { notified += 1; });
    mediator.dispatch({ type: "fleet-changed" });
    await until(() => mediator.getState().runs.status === "ready" && mediator.getState().usage.status === "ready");
    expect(mediator.getState().runs.data).toEqual([run]);
    expect(notified).toBeGreaterThanOrEqual(3);
  });

  it("turns a failed effect into a failure event with its message", async () => {
    const { ports: p } = ports({ loadRuns: async () => { throw new Error("/api/fleet/runs failed (401): unauthorized"); } });
    const mediator = new Mediator(p);
    mediator.dispatch({ type: "fleet-changed" });
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

  it("answers a refresh with its own outcome", async () => {
    const { ports: p } = ports();
    const mediator = new Mediator(p);
    mediator.dispatch({ type: "refresh-usage" });
    expect(mediator.getState().usage.refreshing).toBe(true);
    await until(() => !mediator.getState().usage.refreshing);
    expect(mediator.getState().usage.data).toEqual([{ key: "codex" }]);
  });

  it("does not notify listeners when an event changes nothing", () => {
    const { ports: p } = ports();
    const mediator = new Mediator(p);
    let notified = 0;
    mediator.subscribe(() => { notified += 1; });
    mediator.dispatch({ type: "request-done" });
    expect(notified).toBe(0);
  });

  it("saves a settings change, and forgets the panes' own lenses when the lens for every pane changes", () => {
    const { ports: p, saved, forgotten } = ports();
    const mediator = new Mediator(p);
    mediator.dispatch({ type: "choose-default-view", view: "terminal" });
    expect(forgotten).toEqual([1]);
    expect(saved.map((settings) => settings.defaultView)).toEqual(["terminal"]);
  });

  it("reads the remote access when Settings opens, and says when it could not", async () => {
    const { ports: p } = ports();
    const mediator = new Mediator(p);
    mediator.dispatch({ type: "open-settings" });
    await until(() => mediator.getState().remoteAccess.status === "ready");
    expect(mediator.getState().remoteAccess.data).toEqual(access);
    const failing = new Mediator(ports({ loadRemoteAccess: async () => { throw new Error("offline"); } }).ports);
    failing.dispatch({ type: "open-settings" });
    await until(() => failing.getState().remoteAccess.status === "error");
    expect(failing.getState().remoteAccess.error).toBe("offline");
  });

  it("says the server keeps no devices when it has no device list, and a failure as it came", async () => {
    const none = new Mediator(ports({ loadDevices: async () => null }).ports);
    none.dispatch({ type: "open-settings" });
    await until(() => none.getState().devices.unavailable);
    expect(none.getState().devices.failure).toEqual({ kind: "unavailable" });
    const failing = new Mediator(ports({ loadDevices: async () => { throw new Error("offline"); } }).ports);
    failing.dispatch({ type: "open-settings" });
    await until(() => failing.getState().devices.failure !== null);
    expect(failing.getState().devices.failure).toEqual({ kind: "message", message: "offline" });
  });

  it("sends the state machine's later events on the clock it is given", async () => {
    const { ports: p, timers } = ports();
    const mediator = new Mediator(p);
    mediator.dispatch({ type: "open-settings" });
    await until(() => mediator.getState().devices.list !== null);
    mediator.dispatch({ type: "pair-device" });
    await until(() => mediator.getState().devices.code !== null);
    expect(timers.map((timer) => timer.ms)).toEqual([3000, expect.any(Number)]);
    expect(timers[1]!.ms).toBeGreaterThan(590_000);
    timers[1]!.then();
    expect(mediator.getState().devices.code).toBeNull();
  });

  it("takes a refused change to a PC's sessions back to the tree with herdr's reason", async () => {
    const mediator = new Mediator(ports({ treeRequest: async () => { throw new Error("pane is busy"); } }).ports);
    mediator.dispatch({ type: "tree-close-pane", machineId: "local", paneId: "w1:p2" });
    await until(() => mediator.getState().trees["local"]?.failure !== null && mediator.getState().trees["local"]?.failure !== undefined);
    expect(mediator.getState().trees["local"]?.failure).toMatchObject({ kind: "close", reason: "pane is busy", paneId: "w1:p2" });
  });

  it("opens the stream once this browser is in, feeds its pushes to the state machine, and closes it when locked out", async () => {
    let on: { opened(): void; event(event: import("../../shared/machines.ts").MachineEvent): void } | null = null;
    let closed = 0;
    const mediator = new Mediator(ports({ openStream: (handlers) => { on = handlers; return () => { closed += 1; }; } }).ports);
    mediator.dispatch({ type: "boot", linkToken: null });
    await until(() => on !== null);
    on!.event({ type: "machines", machines: [{ id: "local", name: "pc", kind: "local", enabled: true, state: "connected", error: null, snapshot: null }] });
    expect(mediator.getState().machines.list.map((machine) => machine.id)).toEqual(["local"]);
    mediator.dispatch({ type: "access-loaded", auth: { required: true, authenticated: false } });
    expect(closed).toBe(1);
  });
});
