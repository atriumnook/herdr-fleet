import { describe, expect, it } from "bun:test";
import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import type { Machine } from "../../shared/machines.ts";
import type { HealthAuth, PairedDevice, SessionSnapshot } from "../../shared/protocol.ts";
import { relay, type Emit } from "./bubble.ts";
import { INITIAL_STATE, transition, treeOf, type UiEvent, type UiState } from "./state.ts";

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
    expect(play([{ type: "show-screen", screen: "fleet" }, { type: "show-run", runId: "a" }, { type: "select-pane", machineId: "local", paneId: "w1:x" }], withRuns).state).toMatchObject({ screen: "pane", detail: null });
  });

  it("selects a live run's pane on this PC, again when asked again, and not an ended run's", () => {
    const first = play([{ type: "show-screen", screen: "fleet" }, { type: "open-pane", runId: "a" }], withRuns);
    expect(first.state).toMatchObject({ screen: "pane", selection: { machineId: "local", paneId: "w1:a", auto: false } });
    expect(first.effects).toEqual([{ kind: "store-selection", machineId: "local", paneId: "w1:a" }]);
    const elsewhere = play([{ type: "select-pane", machineId: "local", paneId: "w1:b" }, { type: "show-screen", screen: "fleet" }, { type: "open-pane", runId: "a" }], first.state).state;
    expect(elsewhere.selection.paneId).toBe("w1:a");
    expect(play([{ type: "show-screen", screen: "fleet" }, { type: "open-pane", runId: "gone" }], withRuns).state).toMatchObject({ screen: "fleet", selection: INITIAL_STATE.selection });
  });
});

describe("the selected pane", () => {
  it("selects a pane on a PC and keeps the choice for the next load", () => {
    const { state, effects } = play([{ type: "select-pane", machineId: "pc2", paneId: "w2:p1" }]);
    expect(state.selection).toEqual({ machineId: "pc2", paneId: "w2:p1", auto: false });
    expect(effects).toEqual([{ kind: "store-selection", machineId: "pc2", paneId: "w2:p1" }]);
  });

  // the PC answered that the selected pane closed: the state machine picks herdr's focused one (state.ts settle)
  const gone = { panes: [{ pane_id: "w1:p1" }], focused_pane_id: "w1:p1" } as unknown as SessionSnapshot;

  it("takes another pane once the PC confirms the selected one closed, marked as its own pick", () => {
    const selected = play([{ type: "select-pane", machineId: "local", paneId: "w1:gone" }]).state;
    const { state, effects } = play([{ type: "pane-session-read", machineId: "local", paneId: "w1:gone", session: gone }], selected);
    expect(state.selection).toEqual({ machineId: "local", paneId: "w1:p1", auto: true });
    expect(effects).toEqual([{ kind: "store-selection", machineId: "local", paneId: "w1:p1" }]);
    // an answer about a pane no longer selected comes too late
    const moved = play([{ type: "select-pane", machineId: "local", paneId: "w1:new" }], selected).state;
    expect(transition(moved, { type: "pane-session-read", machineId: "local", paneId: "w1:gone", session: gone }).state.selection).toBe(moved.selection);
  });

  it("drops the shell's own pick once the person chooses a lens there", () => {
    const picked = play([{ type: "select-pane", machineId: "local", paneId: "w1:gone" }, { type: "pane-session-read", machineId: "local", paneId: "w1:gone", session: gone }]).state;
    expect(play([{ type: "selection-confirmed" }], picked).state.selection.auto).toBe(false);
    expect(transition(INITIAL_STATE, { type: "selection-confirmed" }).state).toBe(INITIAL_STATE);
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
    const watching = transition(INITIAL_STATE, { type: "access-loaded", auth: { required: true, authenticated: true, via: "device", role: "watch" } }).state;
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
    expect(effects).toEqual([{ kind: "load-devices", session: 1 }, { kind: "load-remote-access" }]);
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
    expect(asked.effects).toEqual([{ kind: "load-devices", session: 1 }, { kind: "load-remote-access" }]);
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
  // the first opening of Settings is session 1: what its effects answer carries it
  const session = 1;
  const opened = () => play([{ type: "open-settings" }]).state;
  const listed = (devices: PairedDevice[]) => play([{ type: "devices-loaded", devices, session }], opened()).state;
  const pairing = (from = listed([device("a")])) => play([{ type: "pairing-started", code, at: AT, session }], from);

  it("reads the devices each time Settings opens, starting from nothing", () => {
    const { state, effects } = play([{ type: "open-settings" }], { ...INITIAL_STATE, devices: { ...INITIAL_STATE.devices, list: [device("old")], justPaired: "x" } });
    expect(effects).toContainEqual({ kind: "load-devices", session });
    expect(state.devices).toEqual(INITIAL_STATE.devices);
  });

  it("lists what came back, and says when the server keeps no devices", () => {
    expect(listed([device("a")]).devices.list).toEqual([device("a")]);
    const missing = play([{ type: "devices-failed", message: "x", unavailable: true, session }], opened()).state.devices;
    expect(missing).toMatchObject({ list: [], unavailable: true, failure: { kind: "unavailable" } });
    expect(play([{ type: "devices-failed", message: "offline", unavailable: false, session }], opened()).state.devices.failure).toEqual({ kind: "message", message: "offline" });
  });

  it("shows a code once the server hands one out, polls for the device it lets in, and drops it when it expires", () => {
    const asked = play([{ type: "pair-device" }], listed([device("a")]));
    expect(asked.effects).toEqual([{ kind: "start-pairing", session }]);
    const { state, effects } = pairing(asked.state);
    expect(state.devices.code).toEqual(code);
    expect(effects).toEqual([
      { kind: "later", ms: 3000, event: { type: "poll-devices", session, seq: 1 } },
      { kind: "later", ms: 600_000, event: { type: "pairing-expired", code: "123456", session } },
    ]);
    // each poll reads the list and arms the next one, whatever the read brings
    expect(play([{ type: "poll-devices", session, seq: 1 }], state).effects).toEqual([
      { kind: "load-devices", session },
      { kind: "later", ms: 3000, event: { type: "poll-devices", session, seq: 1 } },
    ]);
    expect(play([{ type: "devices-loaded", devices: [device("a")], session }], state).effects).toEqual([]);
    expect(play([{ type: "pairing-expired", code: "123456", session }], state).state.devices.code).toBeNull();
    // a newer code outlives the expiry of the one before
    const newer = play([{ type: "pairing-started", code: { ...code, code: "654321" }, at: AT, session }], state).state;
    expect(play([{ type: "pairing-expired", code: "123456", session }], newer).state.devices.code?.code).toBe("654321");
  });

  it("keeps polling after a read that failed while the code is out", () => {
    const out = pairing().state;
    const failed = play([{ type: "devices-failed", message: "offline", unavailable: false, session }], out).state;
    expect(failed.devices.code).toEqual(code);
    expect(play([{ type: "poll-devices", session, seq: 1 }], failed).effects).toContainEqual({ kind: "load-devices", session });
  });

  it("polls on one chain: a new code ends the chain of the one before", () => {
    const first = pairing().state;
    const second = play([{ type: "pairing-started", code: { ...code, code: "654321" }, at: AT, session }], first).state;
    expect(play([{ type: "poll-devices", session, seq: 1 }], second).effects).toEqual([]);
    expect(play([{ type: "poll-devices", session, seq: 2 }], second).effects).toContainEqual({ kind: "load-devices", session });
    // a rename or a revoke reads the list once, and starts no chain of its own
    expect(play([{ type: "device-changed", session }], second).effects).toEqual([{ kind: "load-devices", session }]);
  });

  it("names the first device to pair as well, once the list was read empty", () => {
    const out = pairing(listed([])).state;
    const { state } = play([{ type: "devices-loaded", devices: [device("a", "iPhone")], session }], out);
    expect(state.devices).toMatchObject({ justPaired: "iPhone", code: null });
  });

  it("takes the first read as it is: what was there already did not just pair", () => {
    expect(listed([device("a")]).devices.justPaired).toBeNull();
  });

  it("names a device that appears while a code is out, and puts the code away", () => {
    const { state } = play([{ type: "devices-loaded", devices: [device("a"), device("b", "iPhone")], session }], pairing().state);
    expect(state.devices).toMatchObject({ justPaired: "iPhone", code: null });
  });

  it("stops polling once the dialog closes or the code is put away", () => {
    const out = pairing().state;
    expect(play([{ type: "end-pairing" }, { type: "poll-devices", session, seq: 1 }], out).effects).toEqual([]);
    expect(play([{ type: "close-settings" }, { type: "poll-devices", session, seq: 1 }], out).effects).toEqual([]);
  });

  it("drops what an earlier opening of Settings left on its way: answers and timers", () => {
    const out = pairing().state;
    const reopened = play([{ type: "close-settings" }, { type: "open-settings" }], out).state;
    expect(play([{ type: "poll-devices", session, seq: 1 }], reopened).effects).toEqual([]);
    expect(transition(reopened, { type: "devices-loaded", devices: [device("old")], session }).state).toBe(reopened);
    const confirming = play([{ type: "revoke-device", id: "a" }], listed([device("a")])).state;
    const again = play([{ type: "close-settings" }, { type: "open-settings" }, { type: "devices-loaded", devices: [device("a")], session: 2 }, { type: "revoke-device", id: "a" }], confirming).state;
    expect(play([{ type: "unconfirm-revoke", id: "a", session, seq: 1 }], again).state.devices.confirming).toBe("a");
  });

  it("renames with the name being typed, and reads the list again", () => {
    const typed = play([{ type: "start-rename", id: "a", label: "a" }, { type: "edit-rename", label: "Desk" }], listed([device("a")])).state;
    expect(typed.devices.renaming).toEqual({ id: "a", label: "Desk" });
    const { state, effects } = play([{ type: "save-rename" }], typed);
    expect(effects).toEqual([{ kind: "rename-device", id: "a", label: "Desk", session }]);
    const done = play([{ type: "device-renamed", session }], state);
    expect(done.state.devices.renaming).toBeNull();
    expect(done.effects).toEqual([{ kind: "load-devices", session }]);
    expect(play([{ type: "cancel-rename" }], typed).state.devices.renaming).toBeNull();
  });

  it("revokes on the second press only, and forgets the first press after a while", () => {
    const first = play([{ type: "revoke-device", id: "a" }], listed([device("a")]));
    expect(first.state.devices.confirming).toBe("a");
    expect(first.effects).toEqual([{ kind: "later", ms: 4000, event: { type: "unconfirm-revoke", id: "a", session, seq: 1 } }]);
    expect(play([{ type: "unconfirm-revoke", id: "a", session, seq: 1 }], first.state).state.devices.confirming).toBeNull();
    const second = play([{ type: "revoke-device", id: "a" }], first.state);
    expect(second.state.devices.confirming).toBeNull();
    expect(second.effects).toEqual([{ kind: "revoke-device", id: "a", session }]);
  });

  it("keeps a failed change's message beside the list", () => {
    const { state } = play([{ type: "device-change-failed", message: "denied", session }], listed([device("a")]));
    expect(state.devices).toMatchObject({ list: [device("a")], failure: { kind: "message", message: "denied" } });
  });
});

describe("the push test", () => {
  // the first opening of Settings is session 1
  const session = 1;
  const opened = () => play([{ type: "open-settings" }]).state;

  it("starts from nothing each time Settings opens", () => {
    const { state } = play([{ type: "open-settings" }], { ...INITIAL_STATE, pushTest: "sent" });
    expect(state.pushTest).toBe("idle");
  });

  it("sends a test push and keeps what came of it", () => {
    const { state, effects } = play([{ type: "send-test-push" }], opened());
    expect(state.pushTest).toBe("sending");
    expect(effects).toEqual([{ kind: "test-push", session }]);
    expect(play([{ type: "push-tested", result: "missing", session }], state).state.pushTest).toBe("missing");
  });

  it("sends one test at a time", () => {
    const sending = play([{ type: "send-test-push" }], opened()).state;
    expect(play([{ type: "send-test-push" }], sending).effects).toEqual([]);
  });

  it("turns alerts on again: sending until it answers", () => {
    const repairing = play([{ type: "repair-alerts" }], opened()).state;
    expect(repairing.pushTest).toBe("sending");
    expect(play([{ type: "alerts-enabled", ok: false, session }], repairing).state.pushTest).toBe("failed");
  });

  it("drops a result that arrives after Settings closed, or in a later opening", () => {
    const sending = play([{ type: "send-test-push" }, { type: "close-settings" }], opened()).state;
    expect(play([{ type: "push-tested", result: "sent", session }], sending).state.pushTest).toBe("sending");
    const reopened = play([{ type: "open-settings" }], sending).state;
    expect(play([{ type: "push-tested", result: "sent", session }], reopened).state.pushTest).toBe("idle");
  });
});

describe("a PC's session tree", () => {
  const pc = "local";
  const tree = (state: UiState) => treeOf(state, pc);

  it("renames a pane with the name being typed, trimmed, and puts the field away at once", () => {
    const typed = play([{ type: "tree-start-pane-rename", machineId: pc, paneId: "w1:p1", label: "old" }, { type: "tree-edit-pane-rename", machineId: pc, label: " build " }]).state;
    expect(tree(typed).paneRename).toEqual({ paneId: "w1:p1", label: " build " });
    const { state, effects } = play([{ type: "tree-save-pane-rename", machineId: pc }], typed);
    expect(tree(state).paneRename).toBeNull();
    expect(effects).toEqual([{ kind: "tree-request", machineId: pc, request: { kind: "rename-pane", paneId: "w1:p1", label: "build" }, viaConfirm: false, revert: null }]);
    expect(tree(play([{ type: "tree-end-pane-rename", machineId: pc }], typed).state).paneRename).toBeNull();
  });

  it("renames only the copy of a workspace that was clicked", () => {
    const typed = play([{ type: "tree-start-workspace-rename", machineId: pc, key: "dir-a\u0000w1", workspaceId: "w1", label: "api" }]).state;
    expect(tree(typed).workspaceRename).toEqual({ key: "dir-a\u0000w1", workspaceId: "w1", label: "api" });
    expect(play([{ type: "tree-save-workspace-rename", machineId: pc }], typed).effects).toEqual([{ kind: "tree-request", machineId: pc, request: { kind: "rename-workspace", workspaceId: "w1", label: "api" }, viaConfirm: false, revert: null }]);
  });

  it("closes a pane that leaves its workspace standing at once, and notes a failure beside its row for a while", () => {
    const { state, effects } = play([{ type: "tree-close-pane", machineId: pc, paneId: "w1:p2" }]);
    expect(effects).toEqual([{ kind: "tree-request", machineId: pc, request: { kind: "close-pane", paneId: "w1:p2" }, viaConfirm: false, revert: null }]);
    const failed = play([{ type: "tree-failed", machineId: pc, request: { kind: "close-pane", paneId: "w1:p2" }, reason: "gone", viaConfirm: false, revert: null }], state);
    expect(tree(failed.state).failure).toEqual({ kind: "close", reason: "gone", paneId: "w1:p2", seq: 1 });
    expect(failed.effects).toEqual([{ kind: "later", ms: 5000, event: { type: "tree-clear-failure", machineId: pc, seq: 1 } }]);
    expect(tree(play([{ type: "tree-clear-failure", machineId: pc, seq: 1 }], failed.state).state).failure).toBeNull();
    // a later failure outlives the timer of the one before
    const again = play([{ type: "tree-failed", machineId: pc, request: { kind: "rename-workspace", workspaceId: "w1", label: "x" }, reason: "denied", viaConfirm: false, revert: null }], failed.state).state;
    expect(tree(play([{ type: "tree-clear-failure", machineId: pc, seq: 1 }], again).state).failure).toMatchObject({ kind: "rename", seq: 2 });
  });

  it("asks before a close that takes the workspace with it, runs it on yes, and puts the question away once done", () => {
    const asked = play([{ type: "tree-ask", machineId: pc, action: { kind: "close-workspace", workspaceId: "w1" }, title: "Close workspace api?", body: "2 panes close with it" }]).state;
    expect(tree(asked).confirm).toMatchObject({ status: "asking", title: "Close workspace api?" });
    const yes = play([{ type: "tree-confirm", machineId: pc }], asked);
    expect(tree(yes.state).confirm?.status).toBe("running");
    expect(yes.effects).toEqual([{ kind: "tree-request", machineId: pc, request: { kind: "close-workspace", workspaceId: "w1" }, viaConfirm: true, revert: null }]);
    // a no while it runs is not taken: the deed cannot be undone
    expect(tree(play([{ type: "tree-cancel", machineId: pc }], yes.state).state).confirm?.status).toBe("running");
    expect(tree(play([{ type: "tree-done", machineId: pc, viaConfirm: true }], yes.state).state).confirm).toBeNull();
    const failed = play([{ type: "tree-failed", machineId: pc, request: { kind: "close-workspace", workspaceId: "w1" }, reason: "busy", viaConfirm: true, revert: null }], yes.state).state;
    expect(tree(failed).confirm).toMatchObject({ status: "asking", error: "busy" });
    expect(tree(failed).failure).toBeNull();
    expect(tree(play([{ type: "tree-cancel", machineId: pc }], failed).state).confirm).toBeNull();
  });

  it("shows a reorder at once, and goes back to the order before when herdr refuses it", () => {
    const { state, effects } = play([{ type: "tree-move-workspace", machineId: pc, workspaceId: "w3", insertIndex: 0, shown: ["w1", "w2", "w3"], herdr: ["w1", "w2", "w3"] }]);
    expect(tree(state).order).toEqual({ basis: ["w1", "w2", "w3"], order: ["w3", "w1", "w2"] });
    expect(effects).toEqual([{ kind: "tree-request", machineId: pc, request: { kind: "move-workspace", workspaceId: "w3", index: 0 }, viaConfirm: false, revert: null }]);
    const failed = play([{ type: "tree-failed", machineId: pc, request: { kind: "move-workspace", workspaceId: "w3", index: 0 }, reason: "no", viaConfirm: false, revert: null }], state).state;
    expect(tree(failed)).toMatchObject({ order: null, failure: { kind: "reorder", reason: "no" } });
    // no move where the workspace already is, or out of the list
    expect(play([{ type: "tree-move-workspace", machineId: pc, workspaceId: "w1", insertIndex: -4, shown: ["w1", "w2"], herdr: ["w1", "w2"] }]).effects).toEqual([]);
  });

  it("keeps each PC's tree apart", () => {
    const state = play([{ type: "tree-start-pane-rename", machineId: "pc2", paneId: "w1:p1", label: "" }]).state;
    expect(treeOf(state, "pc2").paneRename).not.toBeNull();
    expect(tree(state).paneRename).toBeNull();
  });
});

describe("the connection to the server", () => {
  const snapshot = (paneIds: string[], focused: string | null = null) => ({
    version: "0.9.1", protocol: 22, focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: focused,
    workspaces: [], tabs: [], agents: [], panes: paneIds.map((pane_id) => ({ pane_id, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "idle" })),
  }) as unknown as NonNullable<Machine["snapshot"]>;
  const pc = (paneIds: string[], extra: Partial<Machine> = {}): Machine => ({ id: "local", name: "omarchy", kind: "local", enabled: true, state: "connected", error: null, snapshot: snapshot(paneIds), ...extra });
  const open: HealthAuth = { required: false, authenticated: true, via: "local" };
  const kinds = (effects: { kind: string }[]) => effects.map((effect) => effect.kind);
  /** booted, in, with the stream open and these PCs read */
  const inWith = (machines: Machine[]) => {
    const booted = play([{ type: "boot", linkToken: null }]).state;
    return play([{ type: "access-loaded", auth: open }, { type: "machines-loaded", machines, revision: booted.machines.revision }], booted).state;
  };

  it("reads health and the PCs on boot, and polls on one chain", () => {
    const { state, effects } = play([{ type: "boot", linkToken: null }]);
    expect(kinds(effects)).toEqual(["load-health", "load-machines", "later"]);
    expect(effects[2]).toEqual({ kind: "later", ms: 5000, event: { type: "poll", seq: 1 } });
    expect(kinds(play([{ type: "poll", seq: 1 }], state).effects)).toEqual(["load-health", "load-machines", "later"]);
    expect(play([{ type: "poll", seq: 0 }], state).effects).toEqual([]);
  });

  it("signs in with the link's token before the first read", () => {
    const { state, effects } = play([{ type: "boot", linkToken: "secret" }]);
    expect(effects).toEqual([{ kind: "authenticate", token: "secret", reason: "boot" }]);
    // a stale token falls through to the gate the first read shows
    expect(kinds(play([{ type: "authentication-failed", reason: "boot" }], state).effects)).toEqual(["load-health", "load-machines", "later"]);
  });

  it("reads nothing while the page is hidden, and at once when it shows again", () => {
    const hidden = play([{ type: "boot", linkToken: null }, { type: "visibility", visible: false }]).state;
    expect(kinds(play([{ type: "poll", seq: 1 }], hidden).effects)).toEqual(["later"]);
    expect(kinds(play([{ type: "visibility", visible: true }], hidden).effects)).toEqual(["load-health", "load-machines"]);
  });

  it("opens the event stream once in, and closes it when the server locks this browser out", () => {
    const booted = play([{ type: "boot", linkToken: null }]).state;
    const inside = play([{ type: "machines-loaded", machines: [pc(["w1:p1"])], revision: booted.machines.revision }], booted);
    expect(inside.state.connection.locked).toBe(false);
    expect(kinds(inside.effects)).toContain("open-stream");
    const out = play([{ type: "access-loaded", auth: { required: true, authenticated: false, reason: "token_required" } }], inside.state);
    expect(out.state.connection).toMatchObject({ locked: true, reason: "token_required" });
    expect(kinds(out.effects)).toEqual(["close-stream"]);
    // a locked tab only watches health
    expect(kinds(play([{ type: "poll", seq: 1 }], out.state).effects)).toEqual(["load-health", "later"]);
    expect(play([{ type: "machines-failed", message: "unauthorized", unauthorized: true, revision: booted.machines.revision }], booted).state.connection.locked).toBe(true);
  });

  it("drops a read of the PCs that started before a push", () => {
    const state = inWith([pc(["w1:p1"])]);
    const reading = play([{ type: "reload-machines" }], state);
    const revision = (reading.effects.find((effect) => effect.kind === "load-machines") as { revision: number }).revision;
    const pushed = play([{ type: "machines-pushed", machines: [pc(["w1:p1", "w1:p2"])] }], reading.state).state;
    expect(transition(pushed, { type: "machines-loaded", machines: [pc(["w1:p1"])], revision }).state.machines.list).toBe(pushed.machines.list);
  });

  it("applies a pane's status as it is pushed, and reads the PCs once after a burst of session changes", () => {
    const state = inWith([pc(["w1:p1"])]);
    const busy = play([{ type: "machine-message", machineId: "local", message: { type: "pane-status", pane_id: "w1:p1", agent_status: "working" } }], state).state;
    expect(busy.machines.list[0]!.snapshot!.panes[0]!.agent_status).toBe("working");
    const burst = play([
      { type: "machine-message", machineId: "local", message: { type: "session-changed" } },
      { type: "machine-message", machineId: "local", message: { type: "pane-exited", pane_id: "w1:p1" } },
    ], state);
    // (a pane that ended is also told, as an alert: see "alerts")
    expect(burst.effects.filter((effect) => effect.kind === "later")).toEqual([{ kind: "later", ms: 500, event: { type: "refetch-machines" } }]);
    expect(kinds(play([{ type: "refetch-machines" }], burst.state).effects)).toEqual(["load-machines"]);
  });

  it("reads the fleet when this PC's server says it changed, and when the stream opens", () => {
    const state = inWith([pc(["w1:p1"])]);
    expect(kinds(play([{ type: "machine-message", machineId: "local", message: { type: "fleet-changed" } }], state).effects)).toEqual(["load-runs", "load-usage"]);
    expect(kinds(play([{ type: "stream-opened" }], state).effects)).toEqual(["load-runs", "load-usage"]);
  });

  it("pairs with the code a scanned QR brought, once in, and only once", () => {
    const booted = play([{ type: "boot", linkToken: null, pairCode: "123456" }]).state;
    const { state, effects } = play([{ type: "access-loaded", auth: { required: true, authenticated: true, via: "tailscale" } }], booted);
    expect(effects).toContainEqual({ kind: "pair-from-address", code: "123456" });
    expect(play([{ type: "access-loaded", auth: { required: true, authenticated: true, via: "tailscale" } }], state).effects).not.toContainEqual({ kind: "pair-from-address", code: "123456" });
    expect(kinds(play([{ type: "paired-from-address" }], state).effects)).toEqual(["load-health"]);
  });

  it("signs out, then reads whether the gate shows", () => {
    const { state, effects } = play([{ type: "sign-out" }], inWith([pc(["w1:p1"])]));
    expect(effects).toEqual([{ kind: "sign-out" }]);
    expect(kinds(play([{ type: "signed-out" }], state).effects)).toEqual(["load-health"]);
  });

  it("selects herdr's focused pane when none is selected, once the PC's sessions are known", () => {
    const booted = play([{ type: "boot", linkToken: null }]).state;
    const machine = { ...pc(["w1:p1", "w1:p2"]), snapshot: { ...snapshot(["w1:p1", "w1:p2"]), focused_pane_id: "w1:p2" } };
    const { state } = play([{ type: "machines-loaded", machines: [machine], revision: booted.machines.revision }], booted);
    expect(state.selection).toEqual({ machineId: "local", paneId: "w1:p2", auto: false });
  });

  it("confirms with the PC that a selected pane closed before picking another, marked as the shell's own pick", () => {
    const selected = play([{ type: "select-pane", machineId: "local", paneId: "w1:gone" }], inWith([pc(["w1:p1", "w1:gone"])])).state;
    const closed = play([{ type: "machines-pushed", machines: [pc(["w1:p1"])] }], selected);
    expect(closed.effects).toContainEqual({ kind: "confirm-pane-gone", machineId: "local", paneId: "w1:gone" });
    // asked once, however many pushes arrive meanwhile
    expect(play([{ type: "machines-pushed", machines: [pc(["w1:p1"])] }], closed.state).effects).not.toContainEqual({ kind: "confirm-pane-gone", machineId: "local", paneId: "w1:gone" });
    const gone = play([{ type: "pane-session-read", machineId: "local", paneId: "w1:gone", session: snapshot(["w1:p1"]) }], closed.state).state;
    expect(gone.selection).toEqual({ machineId: "local", paneId: "w1:p1", auto: true });
    // a pane created a moment ago is there after all: the selection stays
    const fresh = play([{ type: "pane-session-read", machineId: "local", paneId: "w1:gone", session: snapshot(["w1:p1", "w1:gone"]) }], closed.state).state;
    expect(fresh.selection.paneId).toBe("w1:gone");
  });

  it("leaves the selection alone while its PC is not connected", () => {
    const selected = play([{ type: "select-pane", machineId: "local", paneId: "w1:gone" }], inWith([pc(["w1:p1", "w1:gone"])])).state;
    expect(play([{ type: "machines-pushed", machines: [pc(["w1:p1"], { state: "reconnecting" })] }], selected).effects).toEqual([]);
  });
});

describe("the open pane", () => {
  const live = play([{ type: "pane-connection", connected: true }]).state;

  it("follows the pane's socket: live, and no longer stopped once it is live again", () => {
    expect(live.pane.connected).toBe(true);
    const stalled = play([{ type: "output-stalled" }], live).state;
    expect(stalled.pane.outputStopped).toBe(true);
    expect(play([{ type: "pane-connection", connected: false }, { type: "pane-connection", connected: true }], stalled).state.pane.outputStopped).toBe(false);
  });

  it("closes the drawer and forgets a stalled output for a pane picked, and the live socket only for another PC's", () => {
    const stalled = play([{ type: "drawer", open: true }, { type: "output-stalled" }], live).state;
    const samePc = play([{ type: "select-pane", machineId: "local", paneId: "w1:p2" }], stalled).state;
    expect(samePc).toMatchObject({ drawerOpen: false, pane: { connected: true, outputStopped: false } });
    expect(play([{ type: "select-pane", machineId: "pc2", paneId: "w1:p1" }], stalled).state.pane.connected).toBe(false);
  });

  it("keeps a lens chosen in a pane, saves it for the pane, and makes the shell's own pick the person's", () => {
    const { state, effects } = play([{ type: "choose-lens", key: "w1:p1\nauto\ntrue", storageId: "w1:p1", view: "chat" }]);
    expect(state.pane.lens).toEqual({ key: "w1:p1\nauto\ntrue", view: "chat" });
    expect(effects).toEqual([{ kind: "store-lens", storageId: "w1:p1", view: "chat" }]);
  });

  it("opens and closes the drawer, and toggles it", () => {
    expect(play([{ type: "toggle-drawer" }]).state.drawerOpen).toBe(true);
    expect(play([{ type: "toggle-drawer" }, { type: "drawer", open: false }]).state.drawerOpen).toBe(false);
  });
});

describe("alerts", () => {
  const pane = (status: string) => ({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: status, agent: "claude" });
  const pc = (status: string): Machine => ({
    id: "local", name: "omarchy", kind: "local", enabled: true, state: "connected", error: null,
    snapshot: { version: "0.9.1", protocol: 22, focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1", workspaces: [], tabs: [], agents: [], panes: [pane(status)] } as never,
  });
  const kinds = (effects: { kind: string }[]) => effects.map((effect) => effect.kind);
  /** in, alerts allowed, the PC pushed with its pane idle, another pane open */
  const watching = (extra: Partial<UiState> = {}) => {
    const booted = play([{ type: "boot", linkToken: null, alerts: { permission: "granted", supported: true } }]).state;
    const inside = play([{ type: "machines-loaded", machines: [pc("idle")], revision: booted.machines.revision }, { type: "machines-pushed", machines: [pc("idle")] }, { type: "select-pane", machineId: "local", paneId: "w1:other" }], booted).state;
    return { ...inside, ...extra };
  };
  const status = (agent_status: string, at = 1_000) => ({ type: "machine-message" as const, machineId: "local", message: { type: "pane-status" as const, pane_id: "w1:p1", agent_status: agent_status as never }, at });

  it("tells of a pane that started waiting on the person, in the tab and in the app", () => {
    const { effects } = play([status("blocked")], watching());
    expect(kinds(effects)).toEqual(["drop-in", "notify-pane"]);
    expect(effects[0]).toMatchObject({ kind: "drop-in", machineId: "local", alert: "blocked" });
  });

  it("leaves the tab's own alert to the push service once this device is subscribed", () => {
    const pushed = watching();
    expect(kinds(play([status("blocked")], { ...pushed, alerts: { ...pushed.alerts, push: true } }).effects)).toEqual(["drop-in"]);
  });

  it("drops nothing in for the pane open in front of the person, unless the drawer covers it", () => {
    const open = play([{ type: "select-pane", machineId: "local", paneId: "w1:p1" }], watching()).state;
    expect(kinds(play([status("blocked")], open).effects)).toEqual(["notify-pane"]);
    expect(kinds(play([{ type: "drawer", open: true }, status("blocked")], open).effects)).toEqual(["drop-in", "notify-pane"]);
  });

  it("says nothing of a status that is no news, nor with alerts off", () => {
    const state = watching();
    expect(play([status("idle")], state).effects).toEqual([]);
    const off = play([{ type: "change-settings", patch: { alertsOn: false } }], state).state;
    expect(play([status("blocked")], off).effects.filter((effect) => effect.kind === "drop-in" || effect.kind === "notify-pane")).toEqual([]);
  });

  it("drops in a finished turn only when it was long, by default; the tab's alert, as before, takes no timing", () => {
    const working = play([status("working", 0)], watching()).state;
    expect(kinds(play([status("done", 10_000)], working).effects)).toEqual(["notify-pane"]);
    expect(kinds(play([status("done", 120_000)], working).effects)).toEqual(["drop-in", "notify-pane"]);
  });

  it("asks for the permission, turns alerts on, subscribes and confirms with a push", () => {
    const off = watching({ settings: { ...INITIAL_STATE.settings, alertsOn: false } });
    const asked = play([{ type: "enable-alerts" }], off);
    expect(asked.effects).toEqual([{ kind: "enable-alerts", prefs: { input: true, done: "long" }, session: null }]);
    const granted = play([{ type: "alerts-permission", permission: "granted" }], asked.state).state;
    expect(granted.settings.alertsOn).toBe(true);
    expect(play([{ type: "push-subscribed", on: true, seq: null }], granted).state.alerts.push).toBe(true);
  });

  it("turns alerts off: no push subscription, no tab alerts", () => {
    const on = watching();
    const { state, effects } = play([{ type: "disable-alerts" }], { ...on, alerts: { ...on.alerts, push: true } });
    expect(state.settings.alertsOn).toBe(false);
    expect(state.alerts.push).toBe(false);
    expect(kinds(effects)).toContain("remove-push");
  });

  it("registers this device's subscription again once in, and when its choice of alerts changes", () => {
    const booted = play([{ type: "boot", linkToken: null, alerts: { permission: "granted", supported: true } }]).state;
    const inside = play([{ type: "machines-loaded", machines: [], revision: booted.machines.revision }], booted);
    expect(inside.effects).toContainEqual({ kind: "subscribe-push", prefs: { input: true, done: "long" }, seq: 1 });
    const changed = play([{ type: "change-settings", patch: { alertDone: "always" } }], inside.state);
    expect(changed.effects).toContainEqual({ kind: "subscribe-push", prefs: { input: true, done: "always" }, seq: 2 });
    // an answer to an older registration is superseded
    expect(play([{ type: "push-subscribed", on: false, seq: 1 }], changed.state).state.alerts.push).toBe(changed.state.alerts.push);
  });

  it("turns alerts on again from Settings and reports the outcome there", () => {
    const opened = play([{ type: "open-settings" }], watching()).state;
    const repairing = play([{ type: "repair-alerts" }], opened);
    expect(repairing.state.pushTest).toBe("sending");
    expect(repairing.effects).toContainEqual({ kind: "enable-alerts", prefs: { input: true, done: "long" }, session: opened.settingsSession });
    expect(play([{ type: "alerts-enabled", ok: true, session: opened.settingsSession }], repairing.state).state.pushTest).toBe("sent");
  });

  it("drops the subscription and closes the drawer on the way out", () => {
    const on = watching({ drawerOpen: true });
    const { state } = play([{ type: "sign-out" }], { ...on, alerts: { ...on.alerts, push: true } });
    expect(state).toMatchObject({ drawerOpen: false, alerts: { push: false } });
  });
});

describe("after the review of the App's move", () => {
  const kinds = (effects: { kind: string }[]) => effects.map((effect) => effect.kind);

  it("reads nothing at boot in a tab loaded in the background, and catches up once it shows", () => {
    const { state, effects } = play([{ type: "boot", linkToken: null, visible: false }]);
    expect(kinds(effects)).toEqual(["later"]);
    expect(kinds(play([{ type: "visibility", visible: true }], state).effects)).toEqual(["load-health", "load-machines"]);
  });

  it("drops a registration's answer that comes after alerts went off, or after signing out", () => {
    const booted = play([{ type: "boot", linkToken: null, alerts: { permission: "granted", supported: true } }]).state;
    const inside = play([{ type: "machines-loaded", machines: [], revision: booted.machines.revision }], booted).state;
    const asked = inside.alerts.subscribeSeq;
    const off = play([{ type: "disable-alerts" }], inside).state;
    expect(play([{ type: "push-subscribed", on: true, seq: asked }], off).state.alerts.push).toBe(false);
    const out = play([{ type: "sign-out" }], inside).state;
    expect(play([{ type: "push-subscribed", on: true, seq: asked }], out).state.alerts.push).toBe(false);
  });

  it("looks into a selected pane missing from its PC only when that PC's sessions change", () => {
    const snapshot = (paneIds: string[]) => ({ version: "x", protocol: 1, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null, workspaces: [], tabs: [], agents: [], panes: paneIds.map((pane_id) => ({ pane_id, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "idle" })) }) as never;
    const pc = (id: string, paneIds: string[]): Machine => ({ id, name: id, kind: "local", enabled: true, state: "connected", error: null, snapshot: snapshot(paneIds) });
    const booted = play([{ type: "boot", linkToken: null }]).state;
    const inside = play([{ type: "machines-loaded", machines: [pc("local", ["w1:p1"]), pc("pc2", ["w2:p1"])], revision: booted.machines.revision }, { type: "select-pane", machineId: "local", paneId: "w1:gone" }], booted).state;
    // asked once already; the PC could not answer
    const failed = play([{ type: "pane-session-failed", machineId: "local", paneId: "w1:gone" }], inside).state;
    const elsewhere = play([{ type: "machines-pushed", machines: [failed.machines.list[0]!, pc("pc2", ["w2:p1", "w2:p2"])] }], failed);
    expect(kinds(elsewhere.effects)).not.toContain("confirm-pane-gone");
    const here = play([{ type: "machines-pushed", machines: [pc("local", ["w1:p1", "w1:p3"]), elsewhere.state.machines.list[1]!] }], elsewhere.state);
    expect(kinds(here.effects)).toContain("confirm-pane-gone");
  });
});

