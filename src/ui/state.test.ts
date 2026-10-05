import { describe, expect, it } from "bun:test";
import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import type { PairedDevice } from "../../shared/protocol.ts";
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

describe("settings", () => {
  const opened = () => play([{ type: "open-settings" }]).state;

  it("keeps a change and asks for it to be saved, as the settings tidy it", () => {
    const { state, effects } = play([{ type: "change-settings", patch: { terminalFontSize: 99 } }]);
    expect(state.settings.terminalFontSize).toBe(22);
    expect(effects).toEqual([{ kind: "save-settings", settings: state.settings }]);
  });

  it("forgets every pane's own lens when the lens for every pane changes, and nothing when it stays", () => {
    const { state, effects } = play([{ type: "choose-default-view", view: "chat" }]);
    expect(state.settings.defaultView).toBe("chat");
    expect(effects).toEqual([{ kind: "forget-pane-views" }, { kind: "save-settings", settings: state.settings }]);
    expect(transition(state, { type: "choose-default-view", view: "chat" })).toEqual({ state, effects: [] });
  });

  it("reads how a phone can reach this PC each time the dialog opens, and again when asked", () => {
    const { state, effects } = play([{ type: "open-settings" }]);
    expect(state.settingsDialog).toEqual({ open: true, drafts: {} });
    expect(effects).toEqual([{ kind: "load-devices" }, { kind: "load-remote-access" }]);
    const access = { port: 7000, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } } as const;
    const loaded = play([{ type: "remote-access-loaded", access }], state).state;
    expect(loaded.remoteAccess).toMatchObject({ status: "ready", data: access });
    const again = play([{ type: "load-remote-access" }], loaded);
    expect(again.effects).toEqual([{ kind: "load-remote-access" }]);
    // what was known goes while it is read again: the panel says it is checking
    expect(again.state.remoteAccess).toMatchObject({ status: "loading", data: null });
    expect(play([{ type: "remote-access-failed", message: "offline" }], again.state).state.remoteAccess).toMatchObject({ status: "error", data: null });
  });

  it("keeps a font list being typed apart from the settings, and saves it tidied when committed", () => {
    const typed = play([{ type: "edit-font", field: "terminalFontFamily", text: "D2Coding, " }], opened()).state;
    expect(typed.settingsDialog).toEqual({ open: true, drafts: { terminalFontFamily: "D2Coding, " } });
    expect(typed.settings.terminalFontFamily).toBe("");
    const { state, effects } = play([{ type: "commit-font", field: "terminalFontFamily" }], typed);
    expect(state.settings.terminalFontFamily).toBe("D2Coding");
    expect(state.settingsDialog).toEqual({ open: true, drafts: {} });
    expect(effects).toEqual([{ kind: "save-settings", settings: state.settings }]);
  });

  it("saves nothing when a committed font list tidies to what is already set", () => {
    const typed = play([{ type: "edit-font", field: "chatFontFamily", text: "  " }], opened()).state;
    const { state, effects } = play([{ type: "commit-font", field: "chatFontFamily" }], typed);
    expect(effects).toEqual([]);
    expect(state.settingsDialog).toEqual({ open: true, drafts: {} });
  });

  it("commits the font lists still being typed when the dialog closes (Escape leaves no blur)", () => {
    const typed = play([
      { type: "edit-font", field: "terminalFontFamily", text: "D2Coding" },
      { type: "edit-font", field: "chatFontFamily", text: "Inter" },
    ], opened()).state;
    const { state, effects } = play([{ type: "close-settings" }], typed);
    expect(state.settingsDialog).toEqual({ open: false });
    expect(state.settings).toMatchObject({ terminalFontFamily: "D2Coding", chatFontFamily: "Inter" });
    expect(effects).toEqual([{ kind: "save-settings", settings: state.settings }]);
  });

  it("drops a font list being typed when the same setting changes elsewhere", () => {
    const typed = play([{ type: "edit-font", field: "chatFontFamily", text: "Inter" }], opened()).state;
    const { state } = play([{ type: "change-settings", patch: { chatFontFamily: "Menlo" } }], typed);
    expect(state.settingsDialog).toEqual({ open: true, drafts: {} });
    expect(state.settings.chatFontFamily).toBe("Menlo");
  });

  it("reads the remote access once more after the read in flight, showing nothing it answered meanwhile", () => {
    const access = { port: 7000, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } } as const;
    const asked = play([{ type: "open-settings" }, { type: "load-remote-access" }]);
    expect(asked.effects).toEqual([{ kind: "load-devices" }, { kind: "load-remote-access" }]);
    const { state, effects } = play([{ type: "remote-access-loaded", access }], asked.state);
    expect(effects).toEqual([{ kind: "load-remote-access" }]);
    expect(state.remoteAccess).toMatchObject({ status: "loading", data: null, again: false });
  });

  it("keeps the state itself when Settings is opened while open", () => {
    const state = opened();
    expect(transition(state, { type: "open-settings" })).toEqual({ state, effects: [] });
    expect(transition(state, { type: "open-settings" }).state).toBe(state);
  });

  it("ignores typing into a closed dialog and closing it twice", () => {
    expect(transition(INITIAL_STATE, { type: "edit-font", field: "chatFontFamily", text: "x" })).toEqual({ state: INITIAL_STATE, effects: [] });
    expect(transition(INITIAL_STATE, { type: "close-settings" })).toEqual({ state: INITIAL_STATE, effects: [] });
  });
});

describe("paired devices", () => {
  const device = (id: string, label = id): PairedDevice => ({ id, label, role: "drive", created_at: "2026-10-01T00:00:00Z", last_seen_at: null, current: false });
  const code = { code: "123456", expires_at: "2026-10-05T10:10:00Z" };
  const AT = Date.parse("2026-10-05T10:00:00Z");
  const opened = () => play([{ type: "open-settings" }]).state;
  const listed = (devices: PairedDevice[]) => play([{ type: "devices-loaded", devices }], opened()).state;

  it("reads the devices each time Settings opens, starting from nothing", () => {
    const { state, effects } = play([{ type: "open-settings" }], { ...INITIAL_STATE, devices: { ...INITIAL_STATE.devices, list: [device("old")], justPaired: "x" } });
    expect(effects).toContainEqual({ kind: "load-devices" });
    expect(state.devices).toEqual(INITIAL_STATE.devices);
  });

  it("lists what came back, and says when the server keeps no devices", () => {
    expect(listed([device("a")]).devices.list).toEqual([device("a")]);
    const missing = play([{ type: "devices-failed", message: "x", unavailable: true }], opened()).state.devices;
    expect(missing).toMatchObject({ list: [], unavailable: true, failure: { kind: "unavailable" } });
    expect(play([{ type: "devices-failed", message: "offline", unavailable: false }], opened()).state.devices.failure).toEqual({ kind: "message", message: "offline" });
  });

  it("shows a code once the server hands one out, polls for the device it lets in, and drops it when it expires", () => {
    const asked = play([{ type: "pair-device" }], listed([device("a")]));
    expect(asked.effects).toEqual([{ kind: "start-pairing" }]);
    const { state, effects } = play([{ type: "pairing-started", code, at: AT }], asked.state);
    expect(state.devices.code).toEqual(code);
    expect(effects).toEqual([
      { kind: "later", ms: 3000, event: { type: "poll-devices" } },
      { kind: "later", ms: 600_000, event: { type: "pairing-expired", code: "123456" } },
    ]);
    expect(play([{ type: "poll-devices" }], state).effects).toEqual([{ kind: "load-devices" }]);
    expect(play([{ type: "devices-loaded", devices: [device("a")] }], state).effects).toEqual([{ kind: "later", ms: 3000, event: { type: "poll-devices" } }]);
    expect(play([{ type: "pairing-expired", code: "123456" }], state).state.devices.code).toBeNull();
    // a newer code outlives the expiry of the one before
    const newer = play([{ type: "pairing-started", code: { ...code, code: "654321" }, at: AT }], state).state;
    expect(play([{ type: "pairing-expired", code: "123456" }], newer).state.devices.code?.code).toBe("654321");
  });

  it("names a device that appears while a code is out, and puts the code away", () => {
    const out = play([{ type: "pairing-started", code, at: AT }], listed([device("a")])).state;
    const { state } = play([{ type: "devices-loaded", devices: [device("a"), device("b", "iPhone")] }], out);
    expect(state.devices).toMatchObject({ justPaired: "iPhone", code: null });
  });

  it("stops polling once the dialog closes or the code is put away", () => {
    const out = play([{ type: "pairing-started", code, at: AT }], listed([device("a")])).state;
    expect(play([{ type: "end-pairing" }, { type: "poll-devices" }], out).effects).toEqual([]);
    expect(play([{ type: "close-settings" }, { type: "poll-devices" }], out).effects).toEqual([]);
  });

  it("renames with the name being typed, and reads the list again", () => {
    const typed = play([{ type: "start-rename", id: "a", label: "a" }, { type: "edit-rename", label: "Desk" }], listed([device("a")])).state;
    expect(typed.devices.renaming).toEqual({ id: "a", label: "Desk" });
    const { state, effects } = play([{ type: "save-rename" }], typed);
    expect(effects).toEqual([{ kind: "rename-device", id: "a", label: "Desk" }]);
    const done = play([{ type: "device-renamed" }], state);
    expect(done.state.devices.renaming).toBeNull();
    expect(done.effects).toEqual([{ kind: "load-devices" }]);
    expect(play([{ type: "cancel-rename" }], typed).state.devices.renaming).toBeNull();
  });

  it("revokes on the second press only, and forgets the first press after a while", () => {
    const first = play([{ type: "revoke-device", id: "a" }], listed([device("a")]));
    expect(first.state.devices.confirming).toBe("a");
    expect(first.effects).toEqual([{ kind: "later", ms: 4000, event: { type: "unconfirm-revoke", id: "a" } }]);
    expect(play([{ type: "unconfirm-revoke", id: "a" }], first.state).state.devices.confirming).toBeNull();
    const second = play([{ type: "revoke-device", id: "a" }], first.state);
    expect(second.state.devices.confirming).toBeNull();
    expect(second.effects).toEqual([{ kind: "revoke-device", id: "a" }]);
  });

  it("keeps a failed change's message beside the list", () => {
    const { state } = play([{ type: "device-change-failed", message: "denied" }], listed([device("a")]));
    expect(state.devices).toMatchObject({ list: [device("a")], failure: { kind: "message", message: "denied" } });
  });
});
