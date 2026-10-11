import { describe, expect, it } from "bun:test";
import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import type { Machine } from "../../shared/machines.ts";
import type { ConversationMetadata, ConversationResponse, ConversationTurn, DirectoryListing, FileInfo, HealthAuth, InteractivePrompt, PairedDevice, SessionSnapshot } from "../../shared/protocol.ts";
import { relay, type Emit } from "./bubble.ts";
import { DROPLET_EXIT_MS, DROPLET_EXIT_REDUCED_MS, DROPLET_HOLD_MS, DROPLET_REPEAT_MS, DROPLET_REVEAL_MS } from "../lib/droplet.ts";
import { CARD_CHANGED_MS, CHAT_POLL_MS, CONVERSATION_POLL_MS, FILE_SEARCH_DELAY_MS, INITIAL_STATE, TRANSCRIPT_LINES, transition, treeOf, type ConversationOutcome, type Effect, type Transition, type UiEvent, type UiState } from "./state.ts";

const run = (id: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  id, name: id, role: "worker", agent: "pi", group: "g1", herdrName: `h-${id}`, paneId: `w1:${id}`, cwd: "/w",
  state: "working", depth: 1, interactive: false, worktree: false, startedAt: 1, updatedAt: 1, ...extra,
});
const usage: UsageEntry[] = [{ key: "codex", reading: { readAt: 1, windows: [{ name: "5h", usedPercent: 12 }] } }];

/** a message from the composer of the pane shown, taken by its socket and confirmed: what the last step did */
function sendOne(state: UiState): Transition {
  const asked = transition(state, { type: "composer-send", owner: "w1:p1", machineId: "local", paneId: "w1:p1", text: "x", via: "box", bracketedPaste: false, working: false }).state;
  const started = transition(asked, { type: "submit-started", id: asked.sends.seq }).state;
  return transition(started, { type: "send-result", id: asked.sends.seq, outcome: { kind: "ok" } });
}

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
    expect(first.effects).toEqual([{ kind: "store-selection", machineId: "local", paneId: "w1:a" }, { kind: "remember-pane", machineId: "local", paneId: "w1:a" }]);
    const elsewhere = play([{ type: "select-pane", machineId: "local", paneId: "w1:b" }, { type: "show-screen", screen: "fleet" }, { type: "open-pane", runId: "a" }], first.state).state;
    expect(elsewhere.selection.paneId).toBe("w1:a");
    expect(play([{ type: "show-screen", screen: "fleet" }, { type: "open-pane", runId: "gone" }], withRuns).state).toMatchObject({ screen: "fleet", selection: INITIAL_STATE.selection });
  });
});

describe("the selected pane", () => {
  it("selects a pane on a PC and keeps the choice for the next load", () => {
    const { state, effects } = play([{ type: "select-pane", machineId: "pc2", paneId: "w2:p1" }]);
    expect(state.selection).toEqual({ machineId: "pc2", paneId: "w2:p1", auto: false });
    expect(effects).toEqual([{ kind: "store-selection", machineId: "pc2", paneId: "w2:p1" }, { kind: "remember-pane", machineId: "pc2", paneId: "w2:p1" }]);
  });

  // the PC answered that the selected pane closed: the state machine picks herdr's focused one (state.ts settle)
  const gone = { panes: [{ pane_id: "w1:p1" }], focused_pane_id: "w1:p1" } as unknown as SessionSnapshot;

  it("takes another pane once the PC confirms the selected one closed, marked as its own pick", () => {
    const selected = play([{ type: "select-pane", machineId: "local", paneId: "w1:gone" }]).state;
    const { state, effects } = play([{ type: "pane-session-read", machineId: "local", paneId: "w1:gone", session: gone }], selected);
    expect(state.selection).toEqual({ machineId: "local", paneId: "w1:p1", auto: true });
    expect(effects).toEqual([{ kind: "store-selection", machineId: "local", paneId: "w1:p1" }, { kind: "remember-pane", machineId: "local", paneId: "w1:p1" }]);
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
    // a revoke asked about in an earlier opening is not asked about any more
    const confirming = play([{ type: "revoke-device", id: "a" }], listed([device("a")])).state;
    expect(play([{ type: "close-settings" }, { type: "open-settings" }], confirming).state.devices.confirming).toBeNull();
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

  it("asks in a confirm before revoking, revokes on its yes only, and forgets it on a no", () => {
    const asked = play([{ type: "revoke-device", id: "a" }], listed([device("a")]));
    expect(asked.state.devices.confirming).toBe("a");
    expect(asked.effects).toEqual([]);
    const no = play([{ type: "cancel-revoke" }], asked.state);
    expect(no.state.devices.confirming).toBeNull();
    expect(no.effects).toEqual([]);
    const yes = play([{ type: "confirm-revoke" }], asked.state);
    expect(yes.state.devices.confirming).toBeNull();
    expect(yes.effects).toEqual([{ kind: "revoke-device", id: "a", session }]);
    // a yes with nothing asked does nothing
    expect(play([{ type: "confirm-revoke" }], listed([device("a")])).effects).toEqual([]);
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

  /** the in-app alert showing, if any */
  const dropped = (state: UiState) => state.droplet.shown;

  it("tells of a pane that started waiting on the person, in the tab and in the app", () => {
    const { state, effects } = play([status("blocked")], watching());
    expect(kinds(effects)).toEqual(["later", "notify-pane"]);
    expect(dropped(state)).toMatchObject({ machineId: "local", pane: { pane_id: "w1:p1" }, kind: "blocked" });
  });

  it("leaves the tab's own alert to the push service once this device is subscribed", () => {
    const pushed = watching();
    const subscribed = play([status("blocked")], { ...pushed, alerts: { ...pushed.alerts, push: true } });
    expect(kinds(subscribed.effects)).toEqual(["later"]);
    expect(dropped(subscribed.state)).not.toBeNull();
  });

  it("drops nothing in for the pane open in front of the person, unless the drawer covers it", () => {
    const open = play([{ type: "select-pane", machineId: "local", paneId: "w1:p1" }], watching()).state;
    const front = play([status("blocked")], open);
    expect(kinds(front.effects)).toEqual(["notify-pane"]);
    expect(dropped(front.state)).toBeNull();
    const covered = play([{ type: "drawer", open: true }, status("blocked")], open);
    expect(kinds(covered.effects)).toEqual(["later", "notify-pane"]);
    expect(dropped(covered.state)).not.toBeNull();
  });

  it("says nothing of a status that is no news, nor with alerts off", () => {
    const state = watching();
    expect(play([status("idle")], state).effects).toEqual([]);
    const off = play([{ type: "change-settings", patch: { alertsOn: false } }], state).state;
    const quiet = play([status("blocked")], off);
    expect(quiet.effects.filter((effect) => effect.kind === "notify-pane")).toEqual([]);
    expect(dropped(quiet.state)).toBeNull();
  });

  it("tells a finished turn only when it was long, by default, in the tab as in the page", () => {
    const working = play([status("working", 0)], watching()).state;
    const quick = play([status("done", 10_000)], working);
    expect(quick.effects).toEqual([]);
    expect(dropped(quick.state)).toBeNull();
    // every finish asked for: the quick one too
    const always = play([{ type: "change-settings", patch: { alertDone: "always" } }], working).state;
    expect(kinds(play([status("done", 10_000)], always).effects)).toContain("notify-pane");
    const long = play([status("done", 120_000)], working);
    expect(kinds(long.effects)).toEqual(["later", "notify-pane"]);
    expect(dropped(long.state)).toMatchObject({ kind: "done" });
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


describe("a new session", () => {
  const claude = { kind: "claude", label: "Claude Code" } as never;
  const kinds = (effects: { kind: string }[]) => effects.map((effect) => effect.kind);
  const opened = () => play([{ type: "open-new-session", machineId: "local", defaultCwd: "/w/api" }]);

  it("opens on a PC with the selected pane's folder, reads its agents, and closes the drawer", () => {
    const { state, effects } = play([{ type: "drawer", open: true }, { type: "open-new-session", machineId: "local", defaultCwd: "/w/api" }]);
    expect(state.newSession).toMatchObject({ open: true, machineId: "local", cwd: "/w/api", name: "", agentKind: "", status: "editing" });
    expect(state.drawerOpen).toBe(false);
    expect(effects).toEqual([{ kind: "load-agents", machineId: "local", seq: 1 }]);
  });

  it("takes the agent chosen last when this PC still has it", () => {
    const state = opened().state;
    expect(play([{ type: "new-session-remembered", agentKind: "claude", seq: 1 }, { type: "new-session-agents", agents: [claude], seq: 1 }], state).state.newSession).toMatchObject({ agentKind: "claude" });
    expect(play([{ type: "new-session-remembered", agentKind: "gone", seq: 1 }, { type: "new-session-agents", agents: [claude], seq: 1 }], state).state.newSession).toMatchObject({ agentKind: "" });
  });

  it("starts the session as typed, remembers the agent, and opens the pane it made", () => {
    const typed = play([
      { type: "new-session-agents", agents: [claude], seq: 1 },
      { type: "edit-new-session", field: "agentKind", value: "claude" },
      { type: "edit-new-session", field: "name", value: " api " },
    ], opened().state).state;
    const starting = play([{ type: "submit-new-session" }], typed);
    expect(starting.state.newSession).toMatchObject({ status: "starting" });
    expect(starting.effects).toEqual([
      { kind: "remember-agent", agentKind: "claude" },
      { kind: "create-session", machineId: "local", request: { cwd: "/w/api", label: "api", agent: { kind: "claude" } }, seq: 1 },
    ]);
    // one start at a time
    expect(play([{ type: "submit-new-session" }], starting.state).effects).toEqual([]);
    const made = play([{ type: "new-session-created", paneId: "w9:p1", agentError: null, seq: 1 }], starting.state);
    expect(made.state.newSession).toEqual({ open: false });
    expect(made.state.selection).toMatchObject({ machineId: "local", paneId: "w9:p1" });
    expect(kinds(made.effects)).toEqual(["store-selection", "load-machines", "remember-pane"]);
  });

  it("keeps the dialog on an agent that did not start, offering the pane it made", () => {
    const starting = play([{ type: "edit-new-session", field: "agentKind", value: "claude" }, { type: "submit-new-session" }], opened().state).state;
    const failed = play([{ type: "new-session-created", paneId: "w9:p1", agentError: "claude is not signed in", seq: 1 }], starting).state;
    expect(failed.newSession).toMatchObject({ status: "editing", error: { kind: "message", message: "claude is not signed in" }, createdPaneId: "w9:p1" });
    expect(play([{ type: "submit-new-session" }], failed).state.selection.paneId).toBe("w9:p1");
  });

  it("says a folder that is not there in words, and keeps what was typed", () => {
    const starting = play([{ type: "submit-new-session" }], opened().state).state;
    const failed = play([{ type: "new-session-failed", message: "invalid_cwd", invalidCwd: true, seq: 1 }], starting).state;
    expect(failed.newSession).toMatchObject({ status: "editing", cwd: "/w/api", error: { kind: "invalid-cwd" } });
  });

  it("closes only while nothing starts, and drops what an earlier opening asked", () => {
    const starting = play([{ type: "submit-new-session" }], opened().state).state;
    expect(play([{ type: "close-new-session" }], starting).state.newSession.open).toBe(true);
    const reopened = play([{ type: "close-new-session" }, { type: "open-new-session", machineId: "local", defaultCwd: null }], opened().state).state;
    expect(transition(reopened, { type: "new-session-agents", agents: [claude], seq: 1 }).state).toBe(reopened);
  });
});

describe("the command palette", () => {
  const kinds = (effects: { kind: string }[]) => effects.map((effect) => effect.kind);

  it("opens on the selected pane's PC with an empty search, reading the panes opened last there", () => {
    const { state, effects } = play([{ type: "select-pane", machineId: "local", paneId: "w1:p1" }, { type: "open-palette" }]);
    expect(state.palette).toEqual({ open: true, machineId: "local", query: "", recent: [] });
    expect(effects).toContainEqual({ kind: "load-recent", machineId: "local" });
    expect(play([{ type: "palette-recent", machineId: "local", recent: ["w1:p2"] }], state).state.palette).toMatchObject({ recent: ["w1:p2"] });
  });

  it("keeps the search being typed, and closes", () => {
    const typed = play([{ type: "open-palette" }, { type: "palette-query", text: "api" }]).state;
    expect(typed.palette).toMatchObject({ query: "api" });
    expect(play([{ type: "close-palette" }], typed).state.palette).toEqual({ open: false });
  });

  it("opens the pane picked and closes", () => {
    const { state } = play([{ type: "open-palette" }, { type: "palette-pick", paneId: "w1:p3" }]);
    expect(state.palette).toEqual({ open: false });
    expect(state.selection).toMatchObject({ machineId: "local", paneId: "w1:p3" });
  });

  it("remembers each pane selected, however it was picked, as one opened last", () => {
    const { effects } = play([{ type: "select-pane", machineId: "local", paneId: "w1:p2" }]);
    expect(effects).toContainEqual({ kind: "remember-pane", machineId: "local", paneId: "w1:p2" });
    const same = play([{ type: "select-pane", machineId: "local", paneId: "w1:p2" }]).state;
    expect(kinds(play([{ type: "selection-confirmed" }], same).effects)).not.toContain("remember-pane");
  });
});

describe("the access gate", () => {
  const kinds = (effects: { kind: string }[]) => effects.map((effect) => effect.kind);
  const lockedOut = (pairCode = "") => {
    const booted = play([{ type: "boot", linkToken: null, pairCode }]).state;
    return play([{ type: "access-loaded", auth: { required: true, authenticated: false, reason: "pairing_required" } }], booted);
  };

  it("pairs with a code typed in full, and lets this browser in once the server took it", () => {
    const typed = play([{ type: "gate-edit", field: "code", value: "12a3 456" }], lockedOut().state).state;
    expect(typed.gate.code).toBe("123456");
    const pairing = play([{ type: "gate-pair" }], typed);
    expect(pairing.state.gate.submitting).toBe("code");
    expect(pairing.effects).toEqual([{ kind: "gate-pair", code: "123456" }]);
    const inside = play([{ type: "gate-passed" }], pairing.state);
    expect(inside.state.connection.locked).toBe(false);
    expect(inside.state.gate).toMatchObject({ submitting: null, error: null });
  });

  it("sends nothing for a code short of six digits or an empty token", () => {
    const state = play([{ type: "gate-edit", field: "code", value: "123" }], lockedOut().state).state;
    expect(play([{ type: "gate-pair" }], state).effects).toEqual([]);
    expect(play([{ type: "gate-unlock" }], state).effects).toEqual([]);
  });

  it("says a refused code or token in words, and lets it be tried again", () => {
    const pairing = play([{ type: "gate-edit", field: "code", value: "123456" }, { type: "gate-pair" }], lockedOut().state).state;
    const refused = play([{ type: "gate-failed", via: "code", unauthorized: true, message: "invalid_code" }], pairing).state;
    expect(refused.gate).toMatchObject({ submitting: null, error: { kind: "refused", via: "code" } });
    const unlocking = play([{ type: "gate-edit", field: "token", value: "secret" }, { type: "gate-unlock" }], refused);
    expect(unlocking.effects).toEqual([{ kind: "gate-authenticate", token: "secret" }]);
    expect(play([{ type: "gate-failed", via: "token", unauthorized: false, message: "offline" }], unlocking.state).state.gate.error).toEqual({ kind: "message", via: "token", message: "offline" });
  });

  it("pairs at once with the code a scanned QR brought, once", () => {
    const { state, effects } = lockedOut("654321");
    expect(state.gate.code).toBe("654321");
    expect(effects).toContainEqual({ kind: "gate-pair", code: "654321" });
    expect(kinds(play([{ type: "access-loaded", auth: { required: true, authenticated: false } }], state).effects)).not.toContain("gate-pair");
  });
});

describe("after the review of the dialogs' move", () => {
  const claude = { kind: "claude", label: "Claude Code" } as never;
  const kinds = (effects: { kind: string }[]) => effects.map((effect) => effect.kind);

  it("shows the pane a new session made, from the Fleet screen too", () => {
    const starting = play([{ type: "show-screen", screen: "fleet" }, { type: "open-new-session", machineId: "local", defaultCwd: null }, { type: "submit-new-session" }]).state;
    expect(play([{ type: "new-session-created", paneId: "w9:p1", agentError: null, seq: 1 }], starting).state.screen).toBe("pane");
  });

  it("leaves an open dialog as it is when asked to open again", () => {
    const starting = play([{ type: "open-new-session", machineId: "local", defaultCwd: null }, { type: "submit-new-session" }]).state;
    expect(transition(starting, { type: "open-new-session", machineId: "local", defaultCwd: null }).state).toBe(starting);
  });

  it("keeps the agent chosen last while the list loads or fails, and drops it only when this PC lacks it", () => {
    const opened = play([{ type: "open-new-session", machineId: "local", defaultCwd: null }, { type: "new-session-remembered", agentKind: "claude", seq: 1 }]).state;
    expect(opened.newSession).toMatchObject({ agentKind: "claude" });
    expect(play([{ type: "new-session-agents-failed", message: "offline", seq: 1 }], opened).state.newSession).toMatchObject({ agentKind: "claude" });
    expect(play([{ type: "new-session-agents", agents: [], seq: 1 }], opened).state.newSession).toMatchObject({ agentKind: "" });
    // a choice made while the list loaded stays
    const picked = play([{ type: "edit-new-session", field: "agentKind", value: "codex" }, { type: "new-session-agents", agents: [claude], seq: 1 }], opened).state;
    expect(picked.newSession).toMatchObject({ agentKind: "codex" });
  });

  it("starts a fresh gate after the browser got in, and sends a scanned code only for the page that brought it", () => {
    const booted = play([{ type: "boot", linkToken: null }]).state;
    const typed = play([{ type: "access-loaded", auth: { required: true, authenticated: false } }, { type: "gate-edit", field: "code", value: "123456" }, { type: "gate-edit", field: "token", value: "secret" }, { type: "gate-pair" }, { type: "gate-passed" }], booted).state;
    expect(typed.gate).toMatchObject({ code: "", token: "", submitting: null, error: null });
    const lockedAgain = play([{ type: "access-loaded", auth: { required: true, authenticated: false } }], typed);
    expect(kinds(lockedAgain.effects)).not.toContain("gate-pair");
  });

  it("closes the palette when the selection moves to another PC", () => {
    const open = play([{ type: "open-palette" }]).state;
    expect(play([{ type: "select-pane", machineId: "pc2", paneId: "w2:p1" }], open).state.palette).toEqual({ open: false });
    expect(play([{ type: "select-pane", machineId: "local", paneId: "w1:p2" }], open).state.palette.open).toBe(true);
  });
});

describe("Files and the file viewer", () => {
  const kinds = (effects: { kind: string }[]) => effects.map((effect) => effect.kind);
  /** this browser is in: the server reads its files */
  const inside: UiState = { ...INITIAL_STATE, connection: { ...INITIAL_STATE.connection, locked: false } };
  const onPane = play([{ type: "select-pane", machineId: "local", paneId: "w1:p1" }], inside).state;
  const info = (extra: Partial<FileInfo> = {}): FileInfo => ({ path: "/w/notes.txt", name: "notes.txt", size: 12, modified: "", mime: "text/plain", kind: "text", ...extra });
  /** the viewer opened on `path` from the selected pane, its load asked for */
  const opened = (path = "notes.txt", from = onPane) => play([{ type: "open-file", path }], from);

  it("opens Files on the selected pane, closing the drawer, and not without one", () => {
    const { state } = play([{ type: "drawer", open: true }, { type: "open-files" }], onPane);
    expect(state.files.dialog).toBe(true);
    expect(state.drawerOpen).toBe(false);
    expect(play([{ type: "open-files" }]).state.files.dialog).toBe(false);
    expect(play([{ type: "close-files" }], state).state.files.dialog).toBe(false);
  });

  it("closes Files when another pane is selected, however it was picked: it lists the pane it was opened on", () => {
    const open = play([{ type: "open-files" }], onPane).state;
    expect(play([{ type: "select-pane", machineId: "local", paneId: "w1:p2" }], open).state.files.dialog).toBe(false);
    expect(play([{ type: "palette-pick", paneId: "w1:p2" }], play([{ type: "open-palette" }], open).state).state.files.dialog).toBe(false);
    expect(play([{ type: "selection-confirmed" }], open).state.files.dialog).toBe(true);
  });

  it("opens a file from the selected pane as a new history entry, and reads it", () => {
    const { state, effects } = opened();
    const preview = { path: "notes.txt", paneId: "w1:p1", machineId: "local" };
    expect(state.files.viewer).toEqual({ preview, path: "notes.txt", content: { kind: "opening" }, closing: false });
    expect(effects).toContainEqual({ kind: "history-preview", preview, replace: false });
    expect(effects).toContainEqual({ kind: "load-file", machineId: "local", paneId: "w1:p1", path: "notes.txt", seq: state.files.seq });
  });

  it("reads the start of a text file once its kind is known, from the path found", () => {
    const { state } = opened();
    const { seq } = state.files;
    const read = play([{ type: "file-loaded", seq, outcome: { kind: "info", info: info() } }], state);
    expect(read.state.files.viewer?.content).toEqual({ kind: "file", info: info(), text: null });
    expect(read.effects).toEqual([{ kind: "load-file-text", machineId: "local", paneId: "w1:p1", path: "/w/notes.txt", seq }]);
    expect(play([{ type: "file-text", seq, text: "hello" }], read.state).state.files.viewer?.content).toEqual({ kind: "file", info: info(), text: "hello" });
    const image = play([{ type: "file-loaded", seq, outcome: { kind: "info", info: info({ kind: "image" }) } }], state);
    expect(image.effects).toEqual([]);
  });

  it("drops what an earlier load answers", () => {
    const first = opened().state;
    const second = play([{ type: "viewer-open", path: "other.txt" }], first).state;
    const late = play([{ type: "file-loaded", seq: first.files.seq, outcome: { kind: "outside" } }], second).state;
    expect(late.files.viewer?.content).toEqual({ kind: "opening" });
  });

  it("lists a folder at the path when no file is there: on this PC, or at an absolute path on another", () => {
    const { state } = opened("src");
    const local = play([{ type: "file-loaded", seq: state.files.seq, outcome: { kind: "missing" } }], state);
    expect(local.effects).toEqual([{ kind: "list-folder", machineId: "local", paneId: "w1:p1", path: "src", seq: state.files.seq }]);
    expect(local.state.files.viewer?.content).toEqual({ kind: "opening" });
    expect(play([{ type: "file-folder", seq: state.files.seq, path: "/w/src" }], local.state).state.files.viewer?.content).toEqual({ kind: "folder", path: "/w/src" });
    expect(play([{ type: "file-folder", seq: state.files.seq, path: null }], local.state).state.files.viewer?.content).toEqual({ kind: "failed", reason: "missing" });

    // a remote PC's bridge may list its own folder for a relative path
    const remotePane = play([{ type: "select-pane", machineId: "pc2", paneId: "w2:p1" }], inside).state;
    const relative = opened("src", remotePane).state;
    const missing = play([{ type: "file-loaded", seq: relative.files.seq, outcome: { kind: "missing" } }], relative);
    expect(missing.effects).toEqual([]);
    expect(missing.state.files.viewer?.content).toEqual({ kind: "failed", reason: "missing" });
    for (const path of ["/w/src", "~/src", "~", "C:\\src"]) {
      const absolute = opened(path, remotePane).state;
      expect(kinds(play([{ type: "file-loaded", seq: absolute.files.seq, outcome: { kind: "missing" } }], absolute).effects)).toEqual(["list-folder"]);
    }
  });

  it("says why a file did not open", () => {
    const { state } = opened();
    expect(play([{ type: "file-loaded", seq: state.files.seq, outcome: { kind: "outside" } }], state).state.files.viewer?.content).toEqual({ kind: "failed", reason: "outside" });
    expect(play([{ type: "file-loaded", seq: state.files.seq, outcome: { kind: "failed" } }], state).state.files.viewer?.content).toEqual({ kind: "failed", reason: "failed" });
  });

  it("shows one of several files of a name in place, leaving history as it is", () => {
    const { state } = opened();
    const several = play([{ type: "file-loaded", seq: state.files.seq, outcome: { kind: "candidates", candidates: ["/w/a/notes.txt", "/w/b/notes.txt"] } }], state).state;
    expect(several.files.viewer?.content).toEqual({ kind: "candidates", candidates: ["/w/a/notes.txt", "/w/b/notes.txt"] });
    const chosen = play([{ type: "choose-candidate", path: "/w/b/notes.txt" }], several);
    expect(chosen.state.files.viewer).toMatchObject({ preview: { path: "notes.txt" }, path: "/w/b/notes.txt", content: { kind: "opening" } });
    expect(kinds(chosen.effects)).toEqual(["load-file"]);
  });

  it("opens a file chosen in the viewer's folder in place of the entry, on the viewer's own pane", () => {
    const viewing = opened("src").state;
    const moved = play([{ type: "select-pane", machineId: "pc2", paneId: "w2:p1" }], viewing).state;
    const { state, effects } = play([{ type: "viewer-open", path: "/w/src/a.ts" }], moved);
    const preview = { path: "/w/src/a.ts", paneId: "w1:p1", machineId: "local" };
    expect(state.files.viewer).toMatchObject({ preview, path: "/w/src/a.ts" });
    expect(effects).toContainEqual({ kind: "history-preview", preview, replace: true });
    expect(effects).toContainEqual({ kind: "load-file", machineId: "local", paneId: "w1:p1", path: "/w/src/a.ts", seq: state.files.seq });
  });

  it("closes through history as the system Back does, ignoring opens and closes until the browser moved", () => {
    const { state } = opened();
    const closing = play([{ type: "close-file" }], state);
    expect(closing.effects).toEqual([{ kind: "history-back" }]);
    expect(closing.state.files.viewer?.closing).toBe(true);
    const again = play([{ type: "close-file" }, { type: "open-file", path: "other.txt" }, { type: "viewer-open", path: "x" }], closing.state);
    expect(again.effects).toEqual([]);
    expect(play([{ type: "file-history", preview: null }], closing.state).state.files.viewer).toBeNull();
  });

  it("follows history: Forward or a reload reopens the entry's file, Back closes it", () => {
    const preview = { path: "notes.txt", paneId: "w1:p1", machineId: "pc2" };
    const { state, effects } = play([{ type: "file-history", preview }], inside);
    expect(state.files.viewer).toMatchObject({ preview, path: "notes.txt", content: { kind: "opening" } });
    expect(effects).toEqual([{ kind: "load-file", machineId: "pc2", paneId: "w1:p1", path: "notes.txt", seq: state.files.seq }]);
    expect(play([{ type: "file-history", preview: { ...preview } }], state)).toEqual({ state, effects: [] });
    expect(play([{ type: "file-history", preview: null }], state).state.files.viewer).toBeNull();
    expect(play([{ type: "file-history", preview: null }]).effects).toEqual([]);
  });

  it("reads the file history restored only once this browser is in: a locked one would be refused", () => {
    const preview = { path: "notes.txt", paneId: "w1:p1", machineId: "local" };
    const booted = play([{ type: "boot", linkToken: null }]).state;
    const restored = play([{ type: "file-history", preview }], booted);
    expect(kinds(restored.effects)).not.toContain("load-file");
    expect(restored.state.files.viewer?.content).toEqual({ kind: "opening" });
    const unlocked = play([{ type: "machines-loaded", machines: [], revision: booted.machines.revision }], restored.state);
    expect(unlocked.effects).toContainEqual({ kind: "load-file", machineId: "local", paneId: "w1:p1", path: "notes.txt", seq: unlocked.state.files.seq });
    // locked out and in again: what it showed is read anew
    const shown = play([{ type: "file-loaded", seq: unlocked.state.files.seq, outcome: { kind: "outside" } }], unlocked.state).state;
    const out = play([{ type: "access-loaded", auth: { required: true, authenticated: false, reason: "token_required" } }], shown).state;
    const back = play([{ type: "unlocked" }], out);
    expect(kinds(back.effects)).toContain("load-file");
    expect(back.state.files.viewer?.content).toEqual({ kind: "opening" });
  });

  it("drops a read asked before this browser was locked out, once another file opened meanwhile", () => {
    const first = opened().state;
    const out = play([{ type: "access-loaded", auth: { required: true, authenticated: false, reason: "token_required" } }], first).state;
    const other = play([{ type: "file-history", preview: { path: "other.txt", paneId: "w1:p1", machineId: "local" } }], out).state;
    const late = play([{ type: "file-loaded", seq: first.files.seq, outcome: { kind: "outside" } }], other).state;
    expect(late.files.viewer).toMatchObject({ path: "other.txt", content: { kind: "opening" } });
  });

  it("ignores a choice among files of a name while closing, and reopens the entry history moved to", () => {
    const { state } = opened();
    const several = play([{ type: "file-loaded", seq: state.files.seq, outcome: { kind: "candidates", candidates: ["/w/a/notes.txt"] } }, { type: "close-file" }], state).state;
    expect(play([{ type: "choose-candidate", path: "/w/a/notes.txt" }], several).effects).toEqual([]);
    const moved = play([{ type: "file-history", preview: { path: "other.txt", paneId: "w1:p1", machineId: "local" } }], several);
    expect(moved.state.files.viewer).toMatchObject({ path: "other.txt", closing: false });
    expect(kinds(moved.effects)).toEqual(["load-file"]);
  });
});

describe("the in-app alert", () => {
  const pane = (id: string, status = "idle") => ({ pane_id: id, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: status, agent: "claude" });
  const pc = (ids: string[]): Machine => ({
    id: "local", name: "omarchy", kind: "local", enabled: true, state: "connected", error: null,
    snapshot: { version: "0.9.1", protocol: 22, focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1", workspaces: [], tabs: [], agents: [], panes: ids.map((id) => pane(id)) } as never,
  });
  const kinds = (effects: { kind: string }[]) => effects.map((effect) => effect.kind);
  /** in, the PC's panes idle, another pane open */
  const watching = (ids = ["w1:p1", "w1:p2"]) => {
    const booted = play([{ type: "boot", linkToken: null }]).state;
    return play([{ type: "machines-loaded", machines: [pc(ids)], revision: booted.machines.revision }, { type: "machines-pushed", machines: [pc(ids)] }, { type: "select-pane", machineId: "local", paneId: "w1:open" }], booted).state;
  };
  const blocked = (paneId: string, at = 1_000) => ({ type: "machine-message" as const, machineId: "local", message: { type: "pane-status" as const, pane_id: paneId, agent_status: "blocked" as never }, at });
  const idle = (paneId: string, at = 1_000) => ({ type: "machine-message" as const, machineId: "local", message: { type: "pane-status" as const, pane_id: paneId, agent_status: "idle" as never }, at });
  /** the `later` effects asked for, as the events they send */
  const timers = (effects: Effect[]) => effects.flatMap((effect) => (effect.kind === "later" ? [{ ms: effect.ms, event: effect.event }] : []));

  it("drops in, and goes by itself once its text has shown for a while", () => {
    const { state, effects } = play([blocked("w1:p1")], watching());
    expect(state.droplet).toMatchObject({ shown: { pane: { pane_id: "w1:p1" }, kind: "blocked" }, phase: "in", next: null });
    const [hold] = timers(effects);
    expect(hold!.ms).toBe(DROPLET_REVEAL_MS + DROPLET_HOLD_MS);
    const leaving = play([hold!.event], state);
    expect(leaving.state.droplet.phase).toBe("out");
    const [exit] = timers(leaving.effects);
    expect(exit!.ms).toBe(DROPLET_EXIT_MS);
    expect(play([exit!.event], leaving.state).state.droplet).toMatchObject({ shown: null, phase: "in" });
  });

  it("shows one at a time: a newer one folds the shown one away and takes its place, the newest winning", () => {
    const first = play([blocked("w1:p1")], watching()).state;
    const second = play([blocked("w1:p2")], first);
    expect(second.state.droplet).toMatchObject({ shown: { pane: { pane_id: "w1:p1" } }, phase: "out", next: { pane: { pane_id: "w1:p2" } } });
    const [exit] = timers(second.effects);
    const swapped = play([exit!.event], second.state);
    expect(swapped.state.droplet).toMatchObject({ shown: { pane: { pane_id: "w1:p2" } }, phase: "in", next: null });
    expect(timers(swapped.effects).map((timer) => timer.ms)).toEqual([DROPLET_REVEAL_MS + DROPLET_HOLD_MS]);
    expect(swapped.state.droplet.shown!.id).not.toBe(first.droplet.shown!.id);
  });

  it("drops the same notice for the same pane once when it comes again at once", () => {
    const first = play([blocked("w1:p1", 1_000)], watching()).state;
    const gone = play([{ type: "droplet-dismiss" }], first);
    const after = play([timers(gone.effects)[0]!.event], gone.state).state;
    expect(play([idle("w1:p1", 1_100), blocked("w1:p1", 1_000 + DROPLET_REPEAT_MS - 1)], after).state.droplet.shown).toBeNull();
    expect(play([idle("w1:p1", 1_100), blocked("w1:p1", 1_000 + DROPLET_REPEAT_MS)], after).state.droplet.shown).not.toBeNull();
    // another kind of notice for the pane is news at once
    const done = { type: "machine-message" as const, machineId: "local", message: { type: "pane-exited" as const, pane_id: "w1:p1" }, at: 1_001 };
    expect(play([{ type: "change-settings", patch: { alertDone: "always" } }, done], after).state.droplet.shown).toMatchObject({ kind: "ended" });
  });

  it("stays while pressed, and goes a while after it is let go", () => {
    const shown = play([blocked("w1:p1")], watching());
    const pressed = play([{ type: "droplet-press" }], shown.state).state;
    // the timer asked for before the press no longer counts
    expect(play([timers(shown.effects)[0]!.event], pressed).state.droplet.phase).toBe("in");
    const released = play([{ type: "droplet-release" }], pressed);
    const [hold] = timers(released.effects);
    expect(hold!.ms).toBe(DROPLET_HOLD_MS);
    expect(play([hold!.event], released.state).state.droplet.phase).toBe("out");
  });

  it("goes when flicked up, faster when the device asks for less motion", () => {
    const reduced = play([{ type: "motion-preference", reduced: true }], watching()).state;
    const flicked = play([blocked("w1:p1"), { type: "droplet-dismiss" }], reduced);
    expect(flicked.state.droplet.phase).toBe("out");
    expect(timers(flicked.effects).at(-1)!.ms).toBe(DROPLET_EXIT_REDUCED_MS);
    // a second flick while it goes changes nothing
    expect(play([{ type: "droplet-dismiss" }], flicked.state).effects).toEqual([]);
  });

  it("opens its pane when tapped and goes, closing Files; a pane that is gone only goes", () => {
    const filesOpen = play([{ type: "open-files" }], { ...watching(), selection: { machineId: "local", paneId: "w1:p1", auto: false } }).state;
    const tapped = play([blocked("w1:p2"), { type: "droplet-open" }], filesOpen).state;
    expect(tapped.selection).toMatchObject({ machineId: "local", paneId: "w1:p2" });
    expect(tapped.files.dialog).toBe(false);
    expect(tapped.droplet.phase).toBe("out");
    // the same pane tapped again closes Files as well
    const card = play([blocked("w1:p2", 5_000)], { ...watching(), selection: { machineId: "local", paneId: "w1:p1", auto: false } }).state;
    const same = play([{ type: "select-pane", machineId: "local", paneId: "w1:p2" }, { type: "open-files" }, { type: "droplet-open" }], card).state;
    expect(same.selection.paneId).toBe("w1:p2");
    expect(same.files.dialog).toBe(false);
    // an ended pane's card outlives the pane
    const shown = play([blocked("w1:p2", 9_000)], { ...watching(), selection: { machineId: "local", paneId: "w1:open", auto: false } }).state;
    const gone = play([{ type: "machines-pushed", machines: [pc(["w1:p1"])] }, { type: "droplet-open" }], shown).state;
    expect(gone.selection.paneId).toBe("w1:open");
    expect(gone.droplet.phase).toBe("out");
  });

  it("ignores a tap and a press while it goes", () => {
    const going = play([blocked("w1:p1"), { type: "droplet-dismiss" }], watching()).state;
    expect(play([{ type: "droplet-open" }], going).state.selection.paneId).toBe("w1:open");
    expect(kinds(play([{ type: "droplet-press" }, { type: "droplet-release" }], going).effects)).toEqual([]);
  });
});

describe("the folder browser", () => {
  const listing = (path: string, extra: Partial<DirectoryListing> = {}): DirectoryListing => ({ path, home: "/home/me", parent: path === "/" ? null : path.replace(/\/[^/]+$/, "") || "/", directories: ["a"], truncated: false, ...extra });
  const opened = play([{ type: "open-folders", slot: "new-session", owner: 1, machineId: "pc2", start: "/w/half", files: false }]);
  const seqOf = (state: UiState) => state.folders.open["new-session"]!.seq;

  it("lists the folder it opens at, on its PC, folders only unless files are asked for", () => {
    expect(opened.state.folders.open["new-session"]).toMatchObject({ owner: 1, machineId: "pc2", files: false, listing: null, hidden: false, loading: true, error: null });
    expect(opened.effects).toEqual([{ kind: "list-folders", slot: "new-session", machineId: "pc2", path: "/w/half", hidden: false, files: false, seq: seqOf(opened.state) }]);
    const listed = play([{ type: "folders-listed", slot: "new-session", seq: seqOf(opened.state), listing: listing("/w") }], opened.state).state;
    expect(listed.folders.open["new-session"]).toMatchObject({ listing: listing("/w"), loading: false, error: null });
  });

  it("opens home for a path typed half-way, once; a folder that cannot be opened later says so", () => {
    const seq = seqOf(opened.state);
    const home = play([{ type: "folders-failed", slot: "new-session", seq, reason: "invalid" }], opened.state);
    expect(home.effects).toEqual([{ kind: "list-folders", slot: "new-session", machineId: "pc2", path: "", hidden: false, files: false, seq: seqOf(home.state) }]);
    expect(home.state.folders.open["new-session"]).toMatchObject({ loading: true, error: null });
    const again = play([{ type: "folders-failed", slot: "new-session", seq: seqOf(home.state), reason: "invalid" }], home.state);
    expect(again.effects).toEqual([]);
    expect(again.state.folders.open["new-session"]).toMatchObject({ loading: false, error: "invalid" });
  });

  it("says a bridge that cannot browse, and any other failure, without trying home", () => {
    const seq = seqOf(opened.state);
    expect(play([{ type: "folders-failed", slot: "new-session", seq, reason: "unsupported" }], opened.state).state.folders.open["new-session"]).toMatchObject({ error: "unsupported", loading: false });
    expect(play([{ type: "folders-failed", slot: "new-session", seq, reason: "failed" }], opened.state).effects).toEqual([]);
  });

  it("goes into a folder, up and home with hidden folders as chosen; the newest read wins", () => {
    const listed = play([{ type: "folders-listed", slot: "new-session", seq: seqOf(opened.state), listing: listing("/w") }], opened.state).state;
    const hidden = play([{ type: "show-hidden-folders", slot: "new-session", hidden: true }], listed);
    expect(hidden.effects).toEqual([{ kind: "list-folders", slot: "new-session", machineId: "pc2", path: "/w", hidden: true, files: false, seq: seqOf(hidden.state) }]);
    const into = play([{ type: "browse-folder", slot: "new-session", path: "/w/a" }], hidden.state);
    expect(into.effects).toEqual([{ kind: "list-folders", slot: "new-session", machineId: "pc2", path: "/w/a", hidden: true, files: false, seq: seqOf(into.state) }]);
    // the hidden read asked before answers too late
    const late = play([{ type: "folders-listed", slot: "new-session", seq: seqOf(hidden.state), listing: listing("/w", { directories: [".x", "a"] }) }], into.state).state;
    expect(late.folders.open["new-session"]).toMatchObject({ listing: listing("/w"), loading: true });
    // a failure after a listing keeps the folder shown, and the next read clears it
    const failed = play([{ type: "folders-failed", slot: "new-session", seq: seqOf(into.state), reason: "invalid" }], into.state).state;
    expect(failed.folders.open["new-session"]).toMatchObject({ listing: listing("/w"), error: "invalid" });
    const ok = play([{ type: "browse-folder", slot: "new-session", path: "" }], failed).state;
    expect(play([{ type: "folders-listed", slot: "new-session", seq: seqOf(ok), listing: listing("/home/me") }], ok).state.folders.open["new-session"]).toMatchObject({ error: null });
  });

  it("chooses hidden before the first listing without a read of its own", () => {
    const { state, effects } = play([{ type: "show-hidden-folders", slot: "new-session", hidden: true }], opened.state);
    expect(effects).toEqual([]);
    expect(state.folders.open["new-session"]?.hidden).toBe(true);
  });

  it("starts a browser taking the slot empty, on its own read: the one before's answer is too late", () => {
    const listed = play([{ type: "folders-listed", slot: "new-session", seq: seqOf(opened.state), listing: listing("/w") }], opened.state).state;
    const next = play([{ type: "close-folders", slot: "new-session" }, { type: "open-folders", slot: "new-session", owner: 2, machineId: "pc2", start: "/w/a", files: false }], listed).state;
    expect(next.folders.open["new-session"]).toMatchObject({ owner: 2, listing: null, loading: true });
    expect(play([{ type: "folders-listed", slot: "new-session", seq: seqOf(listed), listing: listing("/w") }], next).state.folders.open["new-session"]?.listing).toBeNull();
  });

    it("keeps each browser apart, and forgets one that closes", () => {
    const both = play([{ type: "open-folders", slot: "viewer", owner: 1, machineId: "local", start: "/w/src", files: true }], opened.state).state;
    expect(Object.keys(both.folders.open).sort()).toEqual(["new-session", "viewer"]);
    const closed = play([{ type: "close-folders", slot: "new-session" }], both).state;
    expect(closed.folders.open["new-session"]).toBeUndefined();
    expect(play([{ type: "folders-listed", slot: "new-session", seq: seqOf(opened.state), listing: listing("/w") }], closed).state.folders.open["new-session"]).toBeUndefined();
    expect(play([{ type: "browse-folder", slot: "new-session", path: "/w" }], closed).effects).toEqual([]);
  });
});

describe("the open pane's terminal session", () => {
  const attached = play([{ type: "pane-attached", paneId: "w1:p1" }]).state;
  const session = (state: UiState) => state.pane.session;

  it("starts each pane afresh: nothing written, no input yet, nothing held or ended", () => {
    const dirty = play([{ type: "pane-output", paneId: "w1:p1", secret: "Password:" }, { type: "pane-exited", paneId: "w1:p1" }, { type: "pane-input-failed", paneId: "w1:p1", message: "busy" }], attached).state;
    expect(session(play([{ type: "pane-attached", paneId: "w1:p2" }], dirty).state)).toEqual({
      paneId: "w1:p2", outputReady: false, inputReady: false, ended: false, held: false, unsupported: false, inputError: null, outputError: null, secret: null,
    });
  });

  it("is ready once output is written, and knows a masked prompt on screen", () => {
    const shown = play([{ type: "pane-output", paneId: "w1:p1", secret: "Password:" }], attached).state;
    expect(session(shown)).toMatchObject({ outputReady: true, secret: "Password:" });
    expect(session(play([{ type: "pane-output", paneId: "w1:p1", secret: null }], shown).state).secret).toBeNull();
    // each write says the same thing again: nothing re-renders for it
    expect(play([{ type: "pane-output", paneId: "w1:p1", secret: "Password:" }], shown).state).toBe(shown);
  });

  it("ignores what is said of a pane it no longer shows", () => {
    for (const event of [
      { type: "pane-output", paneId: "w1:p9", secret: null },
      { type: "pane-exited", paneId: "w1:p9" },
      { type: "pane-attach-held", paneId: "w1:p9" },
      { type: "pane-input-failed", paneId: "w1:p9", message: "x" },
      { type: "pane-terminal-unsupported", paneId: "w1:p9" },
      { type: "pane-input-ready", paneId: "w1:p9", ready: true },
    ] satisfies UiEvent[]) expect(play([event], attached).state).toBe(attached);
  });

  it("is held while another bridge has the terminal, until it resumes; a lost socket forgets the wait", () => {
    const held = play([{ type: "pane-attach-held", paneId: "w1:p1" }], attached).state;
    expect(session(held).held).toBe(true);
    expect(session(play([{ type: "pane-attach-resumed", paneId: "w1:p1" }], held).state).held).toBe(false);
    const ready = play([{ type: "pane-output", paneId: "w1:p1", secret: null }, { type: "pane-input-ready", paneId: "w1:p1", ready: true }], held).state;
    expect(session(play([{ type: "pane-socket-lost" }], ready).state)).toMatchObject({ held: false, outputReady: false, inputReady: false });
  });

  it("says why input or output failed, ends with an output that stopped, and drops a dismissed input error", () => {
    const failed = play([{ type: "pane-input-failed", paneId: "w1:p1", message: "input not ready" }], attached).state;
    expect(session(failed).inputError).toBe("input not ready");
    expect(session(play([{ type: "dismiss-input-error" }], failed).state).inputError).toBeNull();
    const connected = play([{ type: "pane-connection", connected: true }], attached).state;
    const stalled = play([{ type: "pane-output-failed", message: "output stalled" }], connected).state;
    expect(session(stalled)).toMatchObject({ outputError: "output stalled", ended: true });
    expect(stalled.pane.connected).toBe(false);
    expect(session(play([{ type: "pane-terminal-unsupported", paneId: "w1:p1" }], attached).state).unsupported).toBe(true);
    expect(session(play([{ type: "pane-exited", paneId: "w1:p1" }], attached).state).ended).toBe(true);
  });

  it("drops what is said of the pane before once the terminal attached another; a pick alone changes nothing yet", () => {
    const first = play([{ type: "pane-output", paneId: "w1:p1", secret: null }, { type: "pane-input-ready", paneId: "w1:p1", ready: true }], attached).state;
    // the pane picked: the terminal still describes the one it has until it attaches the next
    expect(session(play([{ type: "select-pane", machineId: "local", paneId: "w1:p2" }], first).state)).toMatchObject({ paneId: "w1:p1", outputReady: true });
    const second = play([{ type: "select-pane", machineId: "local", paneId: "w1:p2" }, { type: "pane-attached", paneId: "w1:p2" }], first).state;
    for (const event of [
      { type: "pane-output", paneId: "w1:p1", secret: "Password:" },
      { type: "pane-exited", paneId: "w1:p1" },
      { type: "pane-attach-held", paneId: "w1:p1" },
      { type: "pane-input-ready", paneId: "w1:p1", ready: true },
    ] satisfies UiEvent[]) expect(session(play([event], second).state)).toEqual({ ...session(second) });
  });

    it("keeps the state itself when the socket's connection is polled unchanged", () => {
    const connected = play([{ type: "pane-connection", connected: true }], attached).state;
    expect(play([{ type: "pane-connection", connected: true }], connected).state).toBe(connected);
  });
});

describe("the open pane's terminal socket", () => {
  const opened = play([{ type: "open-pane-socket", machineId: "local" }]);
  const seq = opened.state.pane.socket!.seq;

  it("opens one socket for the PC the terminal shows, not yet connected", () => {
    expect(opened.state.pane.socket).toEqual({ machineId: "local", seq });
    expect(opened.effects).toEqual([{ kind: "open-pane-socket", machineId: "local", seq }]);
    expect(opened.state.pane.connected).toBe(false);
  });

  it("closes it when the terminal goes, but not for another PC's terminal going", () => {
    expect(play([{ type: "close-pane-socket", machineId: "pc2" }], opened.state).effects).toEqual([]);
    const closed = play([{ type: "close-pane-socket", machineId: "local" }], opened.state);
    expect(closed.effects).toEqual([{ kind: "close-pane-socket", seq }]);
    expect(closed.state.pane.socket).toBeNull();
  });

  it("opens the next one afresh: what the one before is still asked goes nowhere", () => {
    const next = play([{ type: "close-pane-socket", machineId: "local" }, { type: "open-pane-socket", machineId: "pc2" }], opened.state).state;
    expect(next.pane.socket).toEqual({ machineId: "pc2", seq: seq + 1 });
    // the terminal leaving the PC before detaches from a socket already closed
    expect(play([{ type: "pane-command", machineId: "local", command: { kind: "detach", paneId: "w1:p1" } }], next).effects).toEqual([]);
  });

  it("passes the terminal's commands to the socket it has", () => {
    const command = { kind: "resize", paneId: "w1:p1", cols: 80, rows: 24, force: true } as const;
    expect(play([{ type: "pane-command", machineId: "local", command }], opened.state).effects).toEqual([{ kind: "pane-command", seq, command }]);
    expect(play([{ type: "pane-command", machineId: "local", command }]).effects).toEqual([]);
  });
});

describe("the input held while the terminal could not take it", () => {
  const owner = "w1:p1";
  const opened = play([{ type: "draft-open", owner }]);
  const ready = (state: UiState, extra: Partial<UiState["pane"]["session"]> = {}): UiState =>
    ({ ...state, pane: { ...state.pane, connected: true, session: { ...state.pane.session, paneId: "w1:p1", ...extra } } });

  it("reads the pane's saved draft as the terminal opens it", () => {
    expect(opened.effects).toEqual([{ kind: "load-draft", owner }]);
    expect(opened.state.pane.draft).toEqual({ owner, value: { text: "", droppedSpecial: 0 } });
    expect(play([{ type: "draft-loaded", owner, value: { text: "ls", droppedSpecial: 1 } }], opened.state).state.pane.draft.value).toEqual({ text: "ls", droppedSpecial: 1 });
    // what another pane's draft read answers is not this one's
    expect(play([{ type: "draft-loaded", owner: "w1:p2", value: { text: "x", droppedSpecial: 0 } }], opened.state).state).toBe(opened.state);
    expect(play([{ type: "draft-open", owner: null }]).effects).toEqual([]);
  });

  it("keeps printable input and counts special keys, saving it", () => {
    const typed = play([{ type: "draft-input", owner, input: "l" }, { type: "draft-input", owner, input: "s" }, { type: "draft-input", owner, input: "\r" }], opened.state);
    expect(typed.state.pane.draft.value).toEqual({ text: "ls", droppedSpecial: 1 });
    expect(typed.effects.at(-1)).toEqual({ kind: "save-draft", owner, value: { text: "ls", droppedSpecial: 1 } });
  });

  it("starts afresh for input on a pane the draft is not of", () => {
    const typed = play([{ type: "draft-input", owner, input: "ls" }], opened.state).state;
    expect(play([{ type: "draft-input", owner: "w1:p2", input: "x" }], typed).state.pane.draft).toEqual({ owner: "w1:p2", value: { text: "x", droppedSpecial: 0 } });
  });

  it("sends the draft only to a terminal that can take it, and clears it once sent", () => {
    const typed = play([{ type: "draft-input", owner, input: "ls" }], opened.state).state;
    expect(play([{ type: "send-draft" }], typed).effects).toEqual([]);
    expect(play([{ type: "send-draft" }], ready(typed, { held: true })).effects).toEqual([]);
    expect(play([{ type: "send-draft" }], ready(typed, { secret: "Password:" })).effects).toEqual([]);
    expect(play([{ type: "send-draft" }], ready(typed)).effects).toEqual([{ kind: "send-draft", owner, paneId: "w1:p1", text: "ls" }]);
    const sent = play([{ type: "draft-sent", owner }], typed);
    expect(sent.state.pane.draft.value).toEqual({ text: "", droppedSpecial: 0 });
    expect(sent.effects).toEqual([{ kind: "save-draft", owner, value: { text: "", droppedSpecial: 0 } }]);
  });

  it("drops the draft when asked", () => {
    const typed = play([{ type: "draft-input", owner, input: "ls" }], opened.state).state;
    expect(play([{ type: "discard-draft" }], typed).state.pane.draft.value).toEqual({ text: "", droppedSpecial: 0 });
  });
});

describe("the chat's waiting prompt and what the composer shares with it", () => {
  const prompt = (id: string, extra: Partial<InteractivePrompt> = {}): InteractivePrompt => ({
    id, agent: "claude", kind: "approval", title: "Allow?", question: "Edit?", body: null, options: [{ label: "Yes", description: null }], multi_select: false, custom_option_index: null, ...extra,
  });
  /** the pane shown, live: connected, attached, not ended */
  const live = (): UiState => {
    const attached = play([{ type: "pane-attached", paneId: "w1:p1" }, { type: "pane-connection", connected: true }]).state;
    return play([{ type: "chat-open", machineId: "local", paneId: "w1:p1" }, { type: "chat-agent", paneId: "w1:p1", agent: true }], attached).state;
  };
  const kinds = (effects: Effect[]) => effects.map((effect) => effect.kind);
  const seqOf = (state: UiState) => state.chat.promptSeq;

  it("reads the prompt once the chat is open on a live pane with an agent, and again a while after each answer", () => {
    const attached = play([{ type: "pane-attached", paneId: "w1:p1" }, { type: "pane-connection", connected: true }]).state;
    const opened = play([{ type: "chat-open", machineId: "local", paneId: "w1:p1" }], attached);
    expect(kinds(opened.effects)).not.toContain("load-chat-prompt");
    const withAgent = play([{ type: "chat-agent", paneId: "w1:p1", agent: true }], opened.state);
    expect(withAgent.effects).toEqual([{ kind: "load-chat-prompt", machineId: "local", paneId: "w1:p1", seq: seqOf(withAgent.state), sent: 0 }]);
    const read = play([{ type: "chat-prompt-read", seq: seqOf(withAgent.state), sent: 0, prompt: prompt("a"), suggestion: null }], withAgent.state);
    expect(read.state.chat.prompt).toEqual(prompt("a"));
    expect(read.effects).toEqual([{ kind: "later", ms: CHAT_POLL_MS, event: { type: "poll-chat-prompt", seq: seqOf(withAgent.state) } }]);
    expect(kinds(play([{ type: "poll-chat-prompt", seq: seqOf(withAgent.state) }], read.state).effects)).toEqual(["load-chat-prompt"]);
  });

  it("keeps the same prompt object while the same prompt is asked, and nothing re-renders for it", () => {
    const state = live();
    const first = play([{ type: "chat-prompt-read", seq: seqOf(state), sent: 0, prompt: prompt("a"), suggestion: null }], state).state;
    const again = play([{ type: "chat-prompt-read", seq: seqOf(state), sent: 0, prompt: prompt("a"), suggestion: null }], first).state;
    expect(again.chat).toBe(first.chat);
  });

  it("takes a suggestion only from a read begun after the latest send", () => {
    const state = live();
    const sent = sendOne(state).state;
    expect(play([{ type: "chat-prompt-read", seq: seqOf(sent), sent: 0, prompt: null, suggestion: "run the tests" }], sent).state.chat.suggestion).toBeNull();
    const taken = play([{ type: "chat-prompt-read", seq: seqOf(sent), sent: 1, prompt: null, suggestion: "run the tests" }], sent).state;
    expect(taken.chat.suggestion).toBe("run the tests");
    // a send drops it: it was for the turn before
    expect(sendOne(taken).state.chat.suggestion).toBeNull();
  });

  it("drops the prompt and the suggestion when a read fails, and goes on reading", () => {
    const state = live();
    const shown = play([{ type: "chat-prompt-read", seq: seqOf(state), sent: 0, prompt: prompt("a"), suggestion: "x" }], state).state;
    const failed = play([{ type: "chat-prompt-failed", seq: seqOf(state) }], shown);
    expect(failed.state.chat).toMatchObject({ prompt: null, suggestion: null });
    expect(kinds(failed.effects)).toEqual(["later"]);
  });

  it("stops reading while the page is hidden, keeping the card but not a typed pick, and reads at once when it is back", () => {
    const state = live();
    const shown = play([{ type: "chat-prompt-read", seq: seqOf(state), sent: 0, prompt: prompt("a"), suggestion: null }, { type: "chat-pending-answer", promptId: "a", answer: { option_index: 0 } }], state).state;
    const hidden = play([{ type: "visibility", visible: false }], shown).state;
    expect(hidden.chat).toMatchObject({ prompt: prompt("a"), pendingAnswer: null });
    expect(play([{ type: "poll-chat-prompt", seq: seqOf(shown) }], hidden).effects).toEqual([]);
    expect(kinds(play([{ type: "visibility", visible: true }], hidden).effects)).toContain("load-chat-prompt");
  });

  it("drops the prompt and the suggestion once the pane is not live, or has no agent", () => {
    const state = live();
    const shown = play([{ type: "chat-prompt-read", seq: seqOf(state), sent: 0, prompt: prompt("a"), suggestion: "x" }], state).state;
    expect(play([{ type: "pane-exited", paneId: "w1:p1" }], shown).state.chat).toMatchObject({ prompt: null, suggestion: null });
    expect(play([{ type: "chat-agent", paneId: "w1:p1", agent: false }], shown).state.chat).toMatchObject({ prompt: null, suggestion: null });
    expect(play([{ type: "pane-socket-lost" }, { type: "pane-connection", connected: false }], shown).state.chat).toMatchObject({ prompt: null, suggestion: null });
  });

  it("forgets the pane's prompt when the chat closes, and is closed only by the pane it is open on", () => {
    const state = live();
    const shown = play([{ type: "chat-prompt-read", seq: seqOf(state), sent: 0, prompt: prompt("a"), suggestion: "x" }], state).state;
    expect(play([{ type: "chat-close", machineId: "local", paneId: "w1:p2" }], shown).state.chat.prompt).not.toBeNull();
    const closed = play([{ type: "chat-close", machineId: "local", paneId: "w1:p1" }], shown).state;
    expect(closed.chat).toMatchObject({ open: null, prompt: null, suggestion: null });
    expect(play([{ type: "chat-prompt-read", seq: seqOf(shown), sent: 0, prompt: prompt("b"), suggestion: null }], closed).state.chat.prompt).toBeNull();
  });

  it("keeps a typed pick for its prompt only: another prompt or the agent at work drops it", () => {
    const state = live();
    const shown = play([{ type: "chat-prompt-read", seq: seqOf(state), sent: 0, prompt: prompt("a"), suggestion: null }, { type: "chat-pending-answer", promptId: "a", answer: { option_index: 0 } }], state).state;
    expect(shown.chat.pendingAnswer).toEqual({ promptId: "a", answer: { option_index: 0 } });
    expect(play([{ type: "chat-prompt-read", seq: seqOf(state), sent: 0, prompt: prompt("b"), suggestion: null }], shown).state.chat.pendingAnswer).toBeNull();
    expect(play([{ type: "chat-pending-answer-done" }], shown).state.chat.pendingAnswer).toBeNull();
  });

  /** a conversation read that reports these settings for the open pane */
  const reportedBy = (state: UiState, metadata: ConversationMetadata): UiState => play([{
    type: "conversation-read", seq: state.conversation.seq, olderSeq: state.conversation.olderSeq,
    outcome: { kind: "ok", conversation: { source: "claude-transcript", history_id: "h1", cursor: null, turns: [], metadata } },
  }], state).state;

  it("keeps the same metadata object while the same settings are reported", () => {
    const metadata = { model: "opus", reasoning_effort: "high", context: { used: 10, window: 100 } };
    const first = reportedBy(live(), metadata);
    expect(first.chat.metadata).toEqual({ paneId: "w1:p1", value: metadata });
    expect(reportedBy(first, { ...metadata, context: { ...metadata.context } }).chat).toBe(first.chat);
    expect(reportedBy(first, { ...metadata, model: "sonnet" }).chat.metadata?.value?.model).toBe("sonnet");
  });

  it("keeps the settings reported for a pane while the chat closes and opens on it again", () => {
    const metadata = { model: "opus", reasoning_effort: "high" };
    const reported = reportedBy(live(), metadata);
    const reopened = play([{ type: "chat-close", machineId: "local", paneId: "w1:p1" }, { type: "chat-open", machineId: "local", paneId: "w1:p1" }], reported).state;
    expect(reopened.chat.metadata).toEqual({ paneId: "w1:p1", value: metadata });
  });

    it("counts a message delivered, so the chat reads at once", () => {
    expect(sendOne(live()).state.chat.delivered).toBe(1);
  });
});

describe("the chat's conversation", () => {
  const user = (text: string): ConversationTurn => ({ role: "user", ts: text, parts: [{ kind: "text", text }] });
  const assistant = (text: string): ConversationTurn => ({ role: "assistant", ts: text, parts: [{ kind: "text", text }] });
  const page = (turns: ConversationTurn[], cursor: string | null, history = "h1", extra: Partial<ConversationResponse> = {}): ConversationResponse =>
    ({ source: "claude-transcript", history_id: history, cursor, turns, ...extra });
  const opened = play([{ type: "chat-open", machineId: "local", paneId: "w1:p1" }]);
  const kinds = (effects: Effect[]) => effects.map((effect) => effect.kind);
  /** what the read under way answers */
  const answer = (state: UiState, outcome: ConversationOutcome) => play([{ type: "conversation-read", seq: state.conversation.seq, olderSeq: state.conversation.olderSeq, outcome }], state);
  const ok = (conversation: ConversationResponse): ConversationOutcome => ({ kind: "ok", conversation });

  it("reads the newest page once the chat opens on a pane, and again a while after each answer", () => {
    const { conversation } = opened.state;
    expect(opened.effects).toContainEqual({ kind: "read-conversation", machineId: "local", paneId: "w1:p1", from: null, seq: conversation.seq, olderSeq: conversation.olderSeq });
    const read = answer(opened.state, ok(page([user("a")], "c:5")));
    expect(read.state.conversation).toMatchObject({ view: { source: "conversation", turns: [user("a")] }, loaded: true, error: null, fresh: true, older: { cursor: "c:5" } });
    expect(read.effects).toEqual([{ kind: "later", ms: CONVERSATION_POLL_MS, event: { type: "poll-conversation", seq: conversation.seq } }]);
    expect(kinds(play([{ type: "poll-conversation", seq: conversation.seq }], read.state).effects)).toEqual(["read-conversation"]);
  });

  it("leaves everything as it is for an unchanged answer (the same object a 304 hands back)", () => {
    const shown = page([user("a")], null);
    const read = answer(opened.state, ok(shown)).state;
    const again = play([{ type: "poll-conversation", seq: read.conversation.seq }], read).state;
    const unchanged = answer(again, ok(shown));
    expect(unchanged.state.conversation.view).toBe(read.conversation.view);
    expect(kinds(unchanged.effects)).toEqual(["later"]);
    // an equal answer that is a new object keeps the view too, and says it is not new
    const equal = answer(again, ok(page([user("a")], null))).state;
    expect(equal.conversation.view).toBe(read.conversation.view);
    expect(equal.conversation.fresh).toBe(true);
    const moved = answer(play([{ type: "poll-conversation", seq: read.conversation.seq }], read).state, ok(page([user("a"), assistant("b")], null))).state;
    expect(moved.conversation.fresh).toBe(false);
  });

  it("adds an earlier page above, and polls the newest from where it started", () => {
    const read = answer(opened.state, ok(page([user("c")], "c:2"))).state;
    const asked = play([{ type: "load-older-conversation" }], read);
    expect(asked.effects).toEqual([{ kind: "read-older-conversation", machineId: "local", paneId: "w1:p1", before: "c:2", olderSeq: read.conversation.olderSeq }]);
    // asked again while it loads: once
    expect(play([{ type: "load-older-conversation" }], asked.state).effects).toEqual([]);
    const loaded = play([{ type: "older-conversation-read", olderSeq: read.conversation.olderSeq, before: "c:2", outcome: ok(page([user("a"), user("b")], null)) }], asked.state);
    expect(loaded.state.conversation.older).toEqual({ turns: [user("a"), user("b")], cursor: null, status: "idle", heldFrom: "c:2" });
    expect(loaded.effects).toContainEqual(expect.objectContaining({ kind: "read-conversation", from: "c:2" }));
    // at the beginning there is nothing before
    expect(play([{ type: "load-older-conversation" }], loaded.state).effects).toEqual([]);
  });

  /** an earlier page shown: the newest is held from "c:20" */
  const holding = (): UiState => {
    const read = answer(opened.state, ok(page([user("21")], "c:20"))).state;
    const asked = play([{ type: "load-older-conversation" }], read).state;
    return play([{ type: "older-conversation-read", olderSeq: read.conversation.olderSeq, before: "c:20", outcome: ok(page([user("11")], "c:10")) }], asked).state;
  };

  it("joins the turns the newest page moved past to the earlier ones, and holds it from its new start", () => {
    const held = holding();
    const moved = answer(held, ok(page([user("36")], "c:35")));
    expect(moved.effects).toEqual([{ kind: "fill-conversation-gap", machineId: "local", paneId: "w1:p1", held: "c:20", start: "c:35", seq: held.conversation.seq, olderSeq: held.conversation.olderSeq }]);
    const filled = play([{ type: "conversation-gap-filled", seq: held.conversation.seq, olderSeq: held.conversation.olderSeq, turns: [user("21"), user("26")] }], moved.state).state;
    expect(filled.conversation.older).toMatchObject({ turns: [user("11"), user("21"), user("26")], heldFrom: "c:35" });
    expect(filled.conversation.view.turns).toEqual([user("36")]);
  });

  it("starts over when the turns between cannot be joined", () => {
    const held = holding();
    const moved = answer(held, ok(page([user("36")], "c:35"))).state;
    const broken = play([{ type: "conversation-gap-filled", seq: held.conversation.seq, olderSeq: held.conversation.olderSeq, turns: null }], moved);
    expect(broken.state.conversation).toMatchObject({ older: { turns: [], heldFrom: null }, view: { turns: [] }, signature: "" });
    expect(broken.effects).toContainEqual(expect.objectContaining({ kind: "read-conversation", from: null }));
  });

  it("drops the earlier pages when the transcript was replaced: a new history id, or a cursor it no longer knows", () => {
    const held = holding();
    const replaced = answer(held, ok(page([user("x")], "c:20", "h2"))).state;
    expect(replaced.conversation.older.turns).toEqual([]);
    expect(replaced.conversation.historyId).toBe("h2");
    const stale = answer(held, { kind: "failed", message: "history changed", status: 409 });
    expect(stale.state.conversation).toMatchObject({ older: { turns: [], heldFrom: null }, signature: "" });
    expect(stale.effects).toEqual([expect.objectContaining({ kind: "read-conversation", from: null, seq: held.conversation.seq })]);
    // an earlier page of another history, or one the transcript no longer knows, starts over
    const asked = play([{ type: "load-older-conversation" }], held).state;
    expect(kinds(play([{ type: "older-conversation-read", olderSeq: held.conversation.olderSeq, before: "c:10", outcome: ok(page([user("1")], null, "h9")) }], asked).effects)).toEqual(["read-conversation"]);
    expect(kinds(play([{ type: "older-conversation-read", olderSeq: held.conversation.olderSeq, before: "c:10", outcome: { kind: "failed", message: "gone", status: 409 } }], asked).effects)).toEqual(["read-conversation"]);
    expect(play([{ type: "older-conversation-read", olderSeq: held.conversation.olderSeq, before: "c:10", outcome: { kind: "failed", message: "down", status: 502 } }], asked).state.conversation.older.status).toBe("failed");
  });

  it("starts over with nothing to call new: the next layout is no news to a reader scrolled up", () => {
    const held = holding();
    const moved = answer(play([{ type: "poll-conversation", seq: held.conversation.seq }], held).state, ok(page([user("21"), user("22")], "c:20"))).state;
    expect(moved.conversation.fresh).toBe(false);
    const stale = answer(moved, { kind: "failed", message: "history changed", status: 409 }).state;
    expect(stale.conversation).toMatchObject({ view: { turns: [] }, fresh: true });
  });

  it("reads no page for an earlier page's answer while the page is hidden", () => {
    const read = answer(opened.state, ok(page([user("c")], "c:2"))).state;
    const asked = play([{ type: "load-older-conversation" }], read).state;
    const hidden = play([{ type: "visibility", visible: false }], asked).state;
    const loaded = play([{ type: "older-conversation-read", olderSeq: read.conversation.olderSeq, before: "c:2", outcome: ok(page([user("a")], null)) }], hidden);
    expect(loaded.effects).toEqual([]);
    expect(loaded.state.conversation.older.heldFrom).toBe("c:2");
    expect(play([{ type: "visibility", visible: true }], loaded.state).effects).toContainEqual(expect.objectContaining({ kind: "read-conversation", from: "c:2" }));
  });

    it("says a failed read, keeping what it read before, and goes on reading", () => {
    const read = answer(opened.state, ok(page([user("a")], null))).state;
    const failed = answer(play([{ type: "poll-conversation", seq: read.conversation.seq }], read).state, { kind: "failed", message: "502 bad gateway", status: 502 });
    expect(failed.state.conversation).toMatchObject({ error: { message: "502 bad gateway", status: 502 }, view: { turns: [user("a")] } });
    expect(kinds(failed.effects)).toEqual(["later"]);
  });

  it("reads the scrollback for an agent with no transcript, after taking what the page says", () => {
    const read = answer(opened.state, ok({ source: "scrollback", turns: [] }));
    expect(read.effects).toEqual([expect.objectContaining({ kind: "read-conversation-scrollback", lines: TRANSCRIPT_LINES })]);
    expect(read.state.conversation.loaded).toBe(false);
    const shown = play([{ type: "conversation-scrollback-read", seq: read.state.conversation.seq, olderSeq: read.state.conversation.olderSeq, outcome: { kind: "ok", text: "$ ls\nREADME.md", truncated: true } }], read.state).state;
    expect(shown.conversation.view).toMatchObject({ source: "scrollback", truncated: true });
    expect(shown.conversation.view.messages.length).toBeGreaterThan(0);
    expect(shown.conversation.older.cursor).toBeUndefined();
  });

  it("reads nothing while the page is hidden, and reads at once when it is back", () => {
    const read = answer(opened.state, ok(page([user("a")], null))).state;
    const hidden = play([{ type: "visibility", visible: false }], read).state;
    expect(play([{ type: "poll-conversation", seq: read.conversation.seq }], hidden).effects).toEqual([]);
    expect(kinds(play([{ type: "visibility", visible: true }], hidden).effects)).toContain("read-conversation");
  });

  it("reads at once once a message is delivered, or a turn starts or ends", () => {
    const read = answer(opened.state, ok(page([user("a")], null))).state;
    const attached = play([{ type: "pane-attached", paneId: "w1:p1" }, { type: "pane-connection", connected: true }], read).state;
    expect(kinds(sendOne(attached).effects)).toContain("read-conversation");
    const pc = (status: string): Machine => ({ id: "local", name: "omarchy", kind: "local", enabled: true, state: "connected", error: null,
      snapshot: { version: "0.9.1", protocol: 22, focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1", workspaces: [], tabs: [], agents: [], panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: status }] } as never });
    const idle = play([{ type: "machines-pushed", machines: [pc("idle")] }], read).state;
    expect(kinds(play([{ type: "machines-pushed", machines: [pc("working")] }], idle).effects)).toContain("read-conversation");
    expect(kinds(play([{ type: "machines-pushed", machines: [pc("done")] }], idle).effects)).not.toContain("read-conversation");
  });

  it("knows the turn that finished before a message went out", () => {
    const read = answer(opened.state, ok(page([user("a"), assistant("b")], null))).state;
    const attached = play([{ type: "pane-attached", paneId: "w1:p1" }, { type: "pane-connection", connected: true }], read).state;
    const asked = play([{ type: "composer-send", owner: "w1:p1", machineId: "local", paneId: "w1:p1", text: "x", via: "box", bracketedPaste: false, working: false }], attached).state;
    const sent = play([{ type: "submit-started", id: asked.sends.seq }], asked).state;
    expect(sent.conversation.sentOver).toEqual({ turn: assistant("b"), page: read.conversation.view.turns });
  });

  it("starts over on another pane, and drops what the pane before answers", () => {
    const read = answer(opened.state, ok(page([user("a")], "c:3"))).state;
    const other = play([{ type: "chat-open", machineId: "local", paneId: "w1:p2" }], read).state;
    expect(other.conversation).toMatchObject({ open: { paneId: "w1:p2" }, view: { turns: [] }, loaded: false, historyId: undefined });
    expect(play([{ type: "conversation-read", seq: read.conversation.seq, olderSeq: read.conversation.olderSeq, outcome: ok(page([user("old")], null)) }], other).state.conversation.view.turns).toEqual([]);
  });
});

describe("the chat beside the pane's", () => {
  const user = (text: string): ConversationTurn => ({ role: "user", ts: text, parts: [{ kind: "text", text }] });
  const page = (turns: ConversationTurn[]): ConversationResponse => ({ source: "claude-transcript", history_id: "h1", cursor: null, turns });
  const side = <T extends UiEvent>(event: T): T => ({ ...event, lens: "side" });
  const prompt = (id: string): InteractivePrompt => ({ id, agent: "claude", kind: "approval", title: "Allow?", question: "Run?", body: null, options: [{ label: "Yes", description: null }], multi_select: false, custom_option_index: null });
  /** the pane's chat open on w1:p1, and the one beside on w1:p2 */
  const both = () => play([
    { type: "pane-attached", paneId: "w1:p1" }, { type: "pane-connection", connected: true },
    { type: "chat-open", machineId: "local", paneId: "w1:p1" }, { type: "chat-agent", paneId: "w1:p1", agent: true },
    side({ type: "chat-open", machineId: "local", paneId: "w1:p2" }), side({ type: "chat-agent", paneId: "w1:p2", agent: true }),
  ]);

  it("opens and reads apart from the pane's, and what it asks for answers it alone", () => {
    const { state, effects } = both();
    expect(state.chat.open).toEqual({ machineId: "local", paneId: "w1:p1" });
    expect(state.side.chat.open).toEqual({ machineId: "local", paneId: "w1:p2" });
    expect(effects).toContainEqual({ kind: "read-conversation", machineId: "local", paneId: "w1:p2", from: null, seq: state.side.conversation.seq, olderSeq: state.side.conversation.olderSeq, lens: "side" });
    expect(effects).toContainEqual({ kind: "load-chat-prompt", machineId: "local", paneId: "w1:p2", seq: state.side.chat.promptSeq, sent: 0, lens: "side" });
    const read = play([side({ type: "conversation-read", seq: state.side.conversation.seq, olderSeq: state.side.conversation.olderSeq, outcome: { kind: "ok", conversation: page([user("thread")]) } })], state);
    expect(read.state.side.conversation.view.turns).toEqual([user("thread")]);
    expect(read.state.conversation).toBe(state.conversation);
    // its poll comes back to it
    expect(read.effects).toEqual([{ kind: "later", ms: CONVERSATION_POLL_MS, lens: "side", event: { type: "poll-conversation", seq: state.side.conversation.seq, lens: "side" } }]);
    // the pane's answer leaves it alone
    const main = play([{ type: "conversation-read", seq: state.conversation.seq, olderSeq: state.conversation.olderSeq, outcome: { kind: "ok", conversation: page([user("coordinator")]) } }], read.state).state;
    expect(main.conversation.view.turns).toEqual([user("coordinator")]);
    expect(main.side).toBe(read.state.side);
  });

  it("is read again on its own pane's status edge, and stops reading once the page is away", () => {
    const { state } = both();
    const panes = (status: string) => [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "idle" }, { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: status }];
    const pc = { id: "local", name: "omarchy", kind: "local", enabled: true, state: "connected", error: null, snapshot: { version: "0.9.1", protocol: 22, focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: null, workspaces: [], tabs: [], agents: [], panes: panes("working") } } as unknown as Machine;
    const working = { ...state, machines: { ...state.machines, list: [pc] } };
    const settled = play([{ type: "machine-message", machineId: "local", message: { type: "pane-status", pane_id: "w1:p2", agent_status: "idle" } }], working);
    expect(settled.effects).toContainEqual(expect.objectContaining({ kind: "read-conversation", paneId: "w1:p2", lens: "side" }));
    expect(settled.effects).not.toContainEqual(expect.objectContaining({ kind: "read-conversation", paneId: "w1:p1" }));
    const away = play([{ type: "visibility", visible: false }], state).state;
    expect(away.side.conversation.seq).toBe(state.side.conversation.seq + 1);
  });

  it("answers its own pane's prompt from its composer, and counts the send on itself", () => {
    const { state } = both();
    const asked = play([side({ type: "chat-prompt-read", seq: state.side.chat.promptSeq, sent: 0, prompt: prompt("p"), suggestion: null })], state).state;
    expect(asked.side.chat.prompt).toEqual(prompt("p"));
    expect(asked.chat.prompt).toBeNull();
    const answered = play([side({ type: "composer-send", owner: "local:w1:p2", machineId: "local", paneId: "w1:p2", text: "Yes", via: "box", bracketedPaste: false, working: false })], asked);
    // an approval is confirmed first: the pick waits on the chat beside, not the pane's
    expect(answered.state.side.chat.pendingAnswer).toMatchObject({ promptId: "p" });
    expect(answered.state.chat.pendingAnswer).toBeNull();
    const sent = play([side({ type: "composer-send", owner: "local:w1:p2", machineId: "local", paneId: "w1:p2", text: "go on", via: "box", bracketedPaste: false, working: false })], state);
    expect(sent.effects).toContainEqual(expect.objectContaining({ kind: "submit", paneId: "w1:p2", text: "go on", lens: "side" }));
    const started = play([side({ type: "submit-started", id: sent.state.sends.seq })], sent.state).state;
    expect(started.side.chat.sent).toBe(1);
    expect(started.chat.sent).toBe(0);
  });

  it("closes apart from the pane's, keeping the same state object when nothing changes", () => {
    const { state } = both();
    const closed = play([side({ type: "chat-close", machineId: "local", paneId: "w1:p2" })], state).state;
    expect(closed.side.chat.open).toBeNull();
    expect(closed.chat.open).toEqual({ machineId: "local", paneId: "w1:p1" });
    expect(transition(closed, side({ type: "chat-close", machineId: "local", paneId: "w1:p2" })).state).toBe(closed);
  });
});

describe("messages held while the agent works", () => {
  const owner = "w1:p1";
  const loaded = (messages: Array<{ id: string; text: string }>, unsaved = false) => play([{ type: "queue-loaded", owner, messages, unsaved }]).state;

  it("reads a pane's held messages as its chat opens, and keeps what the store answers", () => {
    expect(play([{ type: "queue-open", owner }]).effects).toEqual([{ kind: "queue-change", owner, change: { kind: "read" } }]);
    expect(loaded([{ id: "a", text: "one" }], true).queue).toMatchObject({ lists: { [owner]: [{ id: "a", text: "one" }] }, unsaved: { [owner]: true } });
  });

  it("asks the store for every change, and another tab's", () => {
    expect(play([{ type: "queue-edit", owner, id: "a", text: "x" }]).effects).toEqual([{ kind: "queue-change", owner, change: { kind: "edit", id: "a", text: "x" } }]);
    expect(play([{ type: "queue-discard", owner, id: "a" }]).effects).toEqual([{ kind: "queue-change", owner, change: { kind: "remove", id: "a" } }]);
    expect(play([{ type: "queue-stored", owner }]).effects).toEqual([{ kind: "queue-change", owner, change: { kind: "refresh" } }]);
  });

  it("sends one at a time: a message the pane took leaves the queue, a refused one stays and says why", () => {
    const state = loaded([{ id: "a", text: "one" }, { id: "b", text: "two" }]);
    const sendNow = (id: string, text: string): UiEvent => ({ type: "queue-send", owner, id, text, paneId: "w1:p1", bracketedPaste: false });
    const going = play([sendNow("a", "one")], state);
    expect(going.state.queue.sending).toEqual({ owner, id: "a" });
    expect(play([sendNow("b", "two")], going.state).effects).toEqual([]);
    const { seq } = going.state.sends;
    const sent = play([{ type: "send-result", id: seq, outcome: { kind: "ok" } }], going.state);
    expect(sent.state.queue.sending).toBeNull();
    expect(sent.effects).toContainEqual({ kind: "queue-change", owner, change: { kind: "remove", id: "a" } });
    const refused = play([{ type: "send-result", id: seq, outcome: { kind: "failed", code: "input_failed", message: "the pane refused it" } }], going.state);
    expect(refused.state.queue).toMatchObject({ sending: null, error: { owner, id: "a", note: { kind: "submit-failed", code: "input_failed", message: "the pane refused it" } } });
    expect(refused.effects).toEqual([]);
    // the next send clears what the one before said
    expect(play([sendNow("a", "one")], refused.state).state.queue.error).toBeNull();
  });
});

describe("the text typed in the composer and the terminal's input line", () => {
  const owner = "w1:p1";

  it("asks the store for each change to a composer draft, and keeps what it answers", () => {
    expect(play([{ type: "composer-draft", owner, change: { kind: "set", text: "hi" } }]).effects).toEqual([{ kind: "composer-draft-change", owner, change: { kind: "set", text: "hi" } }]);
    const loaded = play([{ type: "composer-draft-loaded", owner, text: "hi", sending: true, settled: null }]).state;
    expect(loaded.drafts.composer[owner]).toEqual({ text: "hi", sending: true });
    // the same answer again changes nothing
    expect(play([{ type: "composer-draft-loaded", owner, text: "hi", sending: true, settled: null }], loaded).state).toBe(loaded);
    expect(play([{ type: "composer-draft-loaded", owner, text: " again", sending: false, settled: { text: " again", edited: false } }], loaded).state.drafts.settled[owner]).toEqual({ text: " again", edited: false });
  });

  it("asks the store for each change to an input line, and keeps what it answers", () => {
    expect(play([{ type: "line-draft", owner, change: { kind: "acknowledge" } }]).effects).toEqual([{ kind: "line-draft-change", owner, change: { kind: "acknowledge" } }]);
    expect(play([{ type: "line-draft-loaded", owner, text: "ls", sending: false }]).state.drafts.line[owner]).toEqual({ text: "ls", sending: false });
  });
});

describe("sending a message", () => {
  const owner = "w1:p1";
  const prompt = (id: string, extra: Partial<InteractivePrompt> = {}): InteractivePrompt => ({
    id, agent: "codex", kind: "question", title: "Pick", question: "Which?", body: null, options: [{ label: "a", description: null }, { label: "b", description: null }], multi_select: false, custom_option_index: null, ...extra,
  });
  /** the pane shown and connected, its chat open on an agent */
  const ready = (): UiState => play([{ type: "pane-attached", paneId: "w1:p1" }, { type: "pane-connection", connected: true }, { type: "chat-open", machineId: "local", paneId: "w1:p1" }, { type: "chat-agent", paneId: "w1:p1", agent: true }]).state;
  const send = (text: string, extra: Partial<Extract<UiEvent, { type: "composer-send" }>> = {}): Extract<UiEvent, { type: "composer-send" }> =>
    ({ type: "composer-send", owner, machineId: "local", paneId: "w1:p1", text, via: "box", bracketedPaste: false, working: false, ...extra });
  const kinds = (effects: Effect[]) => effects.map((effect) => effect.kind);
  const withPrompt = (state: UiState, shown: InteractivePrompt): UiState => ({ ...state, chat: { ...state.chat, prompt: shown } });

  it("submits a message, holding the draft while it is on its way, and counts it sent", () => {
    const { state, effects } = play([send("hello")], ready());
    expect(effects).toEqual([
      { kind: "composer-draft-change", owner, change: { kind: "begin", sent: "hello" } },
      { kind: "submit", id: state.sends.seq, paneId: "w1:p1", text: "hello", payload: "hello", typed: false },
    ]);
    // counted sent once the socket took it: the suggestion was for the turn before
    expect(state.chat.sent).toBe(0);
    expect(play([{ type: "submit-started", id: state.sends.seq }], state).state.chat.sent).toBe(1);
    // a second while it is on its way goes nowhere
    expect(play([send("again")], state).effects).toEqual([]);
  });

  it("leaves only what was not sent once the pane took it, and the chat reads at once", () => {
    const sending = play([send("hello")], ready()).state;
    const done = play([{ type: "send-result", id: sending.sends.seq, outcome: { kind: "ok" } }], sending);
    expect(done.effects).toEqual([
      { kind: "composer-draft-change", owner, change: { kind: "settle", sent: "hello" } },
      { kind: "composer-draft-change", owner, change: { kind: "end" } },
      expect.objectContaining({ kind: "read-conversation" }),
    ]);
    expect(done.state.sends.outcomes[`composer:${owner}`]).toEqual({ id: sending.sends.seq, outcome: { kind: "sent" } });
    expect(done.state.chat.delivered).toBe(1);
  });

  it("keeps the text when the pane refused it, or it was not confirmed, and says why", () => {
    const sending = play([send("hello")], ready()).state;
    const refused = play([{ type: "send-result", id: sending.sends.seq, outcome: { kind: "failed", code: "input_failed", message: "no" } }], sending);
    expect(refused.effects).toEqual([{ kind: "composer-draft-change", owner, change: { kind: "end" } }]);
    expect(refused.state.sends.outcomes[`composer:${owner}`]?.outcome).toEqual({ kind: "submit-failed", code: "input_failed", message: "no" });
    expect(play([{ type: "send-result", id: sending.sends.seq, outcome: { kind: "unconfirmed" } }], sending).state.sends.outcomes[`composer:${owner}`]?.outcome).toEqual({ kind: "unconfirmed" });
    // no socket to take it: nothing to say, the text stays
    expect(play([{ type: "send-result", id: sending.sends.seq, outcome: { kind: "not-sent" } }], sending).state.sends.outcomes[`composer:${owner}`]?.outcome).toEqual({ kind: "not-sent" });
  });

  it("sends nothing into a masked prompt or a terminal another app holds", () => {
    const state = ready();
    for (const session of [{ secret: "Password:" }, { held: true }]) {
      const blocked = { ...state, pane: { ...state.pane, session: { ...state.pane.session, ...session } } };
      const { effects, state: after } = play([send("hello")], blocked);
      expect(effects).toEqual([]);
      expect(after.sends.outcomes[`composer:${owner}`]?.outcome).toEqual({ kind: "not-sent" });
    }
  });

  it("holds a message while the agent works, clearing the box", () => {
    const { effects, state } = play([send("later", { working: true })], ready());
    expect(effects).toEqual([
      { kind: "queue-change", owner, change: { kind: "add", text: "later" } },
      { kind: "composer-draft-change", owner, change: { kind: "begin", sent: "later" } },
      { kind: "composer-draft-change", owner, change: { kind: "settle", sent: "later" } },
      { kind: "composer-draft-change", owner, change: { kind: "end" } },
    ]);
    expect(state.sends.outcomes[`composer:${owner}`]?.outcome).toEqual({ kind: "sent" });
  });

  it("answers the waiting prompt with one of its options, and refuses what is not one", () => {
    const shown = withPrompt(ready(), prompt("q"));
    const refused = play([send("9")], shown);
    expect(refused.effects).toEqual([]);
    expect(refused.state.sends.outcomes[`composer:${owner}`]?.outcome).toEqual({ kind: "refused", prompt: prompt("q") });
    const answering = play([send("1")], shown);
    expect(answering.effects).toEqual([
      { kind: "composer-draft-change", owner, change: { kind: "begin", sent: "1" } },
      { kind: "answer-prompt", id: answering.state.sends.seq, machineId: "local", paneId: "w1:p1", promptId: "q", answer: { option_index: 0 } },
    ]);
    const changed = play([{ type: "answer-result", id: answering.state.sends.seq, outcome: { kind: "failed", status: 409, code: "prompt_changed", message: "changed" } }], answering.state);
    expect(changed.state.sends.outcomes[`composer:${owner}`]?.outcome).toEqual({ kind: "answer-changed" });
    expect(kinds(changed.effects)).toEqual(["composer-draft-change", "load-chat-prompt"]);
    const answered = play([{ type: "answer-result", id: answering.state.sends.seq, outcome: { kind: "ok" } }], answering.state);
    expect(kinds(answered.effects)).toEqual(["composer-draft-change", "composer-draft-change", "load-chat-prompt"]);
  });

  it("keeps a pick an approval must confirm in its card, clearing the box", () => {
    const shown = withPrompt(ready(), prompt("a", { kind: "approval" }));
    const { state, effects } = play([send("1")], shown);
    expect(state.chat.pendingAnswer).toEqual({ promptId: "a", answer: { option_index: 0 } });
    expect(kinds(effects)).toEqual(["composer-draft-change", "composer-draft-change", "composer-draft-change"]);
    expect(state.sends.outcomes[`composer:${owner}`]?.outcome).toEqual({ kind: "sent" });
  });

  it("sends nothing while Codex has a question open in the terminal", () => {
    const { state, effects } = play([send("stop")], withPrompt(ready(), prompt("q", { queued: "open" })));
    expect(effects).toEqual([]);
    expect(state.sends.outcomes[`composer:${owner}`]?.outcome).toEqual({ kind: "open-queue" });
  });

  it("sends a quick reply as typed, leaving the box alone", () => {
    const { effects } = play([send("yes", { via: "quick" })], ready());
    expect(effects).toEqual([
      { kind: "composer-draft-change", owner, change: { kind: "begin" } },
      expect.objectContaining({ kind: "submit", text: "yes" }),
    ]);
  });

  it("types the input line with its own Enter, and keeps text typed meanwhile", () => {
    const { state, effects } = play([{ type: "line-send", owner, paneId: "w1:p1", text: "ls", bracketedPaste: false }], ready());
    expect(effects).toEqual([
      { kind: "line-draft-change", owner, change: { kind: "begin" } },
      { kind: "submit", id: state.sends.seq, paneId: "w1:p1", text: "ls", payload: "ls", typed: true },
    ]);
    expect(state.chat.sent).toBe(0);
    const done = play([{ type: "send-result", id: state.sends.seq, outcome: { kind: "ok" } }], state);
    expect(done.effects).toEqual([
      { kind: "line-draft-change", owner, change: { kind: "acknowledge" } },
      { kind: "line-draft-change", owner, change: { kind: "end" } },
    ]);
  });

  it("ignores an answer for a request it does not know, and keeps a composer's and an input line's sends apart", () => {
    const state = ready();
    expect(play([{ type: "send-result", id: 99, outcome: { kind: "ok" } }], state).state).toBe(state);
    expect(play([{ type: "submit-started", id: 99 }], state).state).toBe(state);
    const composing = play([send("hello")], state).state;
    expect(kinds(play([{ type: "line-send", owner, paneId: "w1:p1", text: "ls", bracketedPaste: false }], composing).effects)).toEqual(["line-draft-change", "submit"]);
  });

  it("says a held message was not sent into a masked prompt or a terminal another app holds", () => {
    const state = play([{ type: "queue-loaded", owner, messages: [{ id: "m", text: "held" }], unsaved: false }], ready()).state;
    const masked = { ...state, pane: { ...state.pane, session: { ...state.pane.session, secret: "Password:" } } };
    const { state: after, effects } = play([{ type: "queue-send", owner, id: "m", text: "held", paneId: "w1:p1", bracketedPaste: false }], masked);
    expect(effects).toEqual([]);
    expect(after.queue.error).toEqual({ owner, id: "m", note: { kind: "not-sent" } });
  });

    it("sends a held message when Send now is pressed, one at a time", () => {
    const state = play([{ type: "queue-loaded", owner, messages: [{ id: "m", text: "held" }], unsaved: false }], ready()).state;
    const going = play([{ type: "queue-send", owner, id: "m", text: "held", paneId: "w1:p1", bracketedPaste: false }], state);
    expect(going.state.queue.sending).toEqual({ owner, id: "m" });
    expect(going.effects).toEqual([expect.objectContaining({ kind: "submit", text: "held", typed: false })]);
    const done = play([{ type: "send-result", id: going.state.sends.seq, outcome: { kind: "ok" } }], going.state);
    expect(done.effects).toContainEqual({ kind: "queue-change", owner, change: { kind: "remove", id: "m" } });
    expect(done.state.queue.sending).toBeNull();
  });
});

describe("what the composer completes", () => {
  const kinds = (effects: Effect[]) => effects.map((effect) => effect.kind);

  it("reads the pane's slash commands as its composer opens, and the usage once", () => {
    const opened = play([{ type: "completions-open", machineId: "local", paneId: "w1:p1" }]);
    expect(opened.effects).toEqual([{ kind: "load-commands", machineId: "local", paneId: "w1:p1" }, { kind: "load-slash-usage" }]);
    const listed = play([{ type: "commands-loaded", machineId: "local", paneId: "w1:p1", commands: [{ name: "review", source: "builtin" } as never] }, { type: "slash-usage-loaded", usage: { review: 2 } }], opened.state).state;
    expect(listed.completions.commands).toMatchObject({ paneId: "w1:p1", list: [{ name: "review" }] });
    expect(listed.completions.slashUsage).toEqual({ review: 2 });
    expect(kinds(play([{ type: "completions-open", machineId: "local", paneId: "w1:p2" }], listed).effects)).toEqual(["load-commands", "load-slash-usage"]);
    // another pane's list answering late is not this one's
    const other = play([{ type: "completions-open", machineId: "local", paneId: "w1:p2" }], listed).state;
    expect(play([{ type: "commands-loaded", machineId: "local", paneId: "w1:p1", commands: [{ name: "late", source: "builtin" } as never] }], other).state.completions.commands).toEqual({ machineId: "local", paneId: "w1:p2", list: [] });
  });

  it("searches the pane's files a moment after the typing stops, the newest search winning", () => {
    const asked = play([{ type: "file-query", machineId: "local", paneId: "w1:p1", query: "src" }]);
    const { seq } = asked.state.completions.files;
    expect(asked.effects).toEqual([{ kind: "later", ms: FILE_SEARCH_DELAY_MS, event: { type: "search-files", seq } }]);
    expect(play([{ type: "search-files", seq }], asked.state).effects).toEqual([{ kind: "search-files", machineId: "local", paneId: "w1:p1", query: "src", seq }]);
    const typed = play([{ type: "file-query", machineId: "local", paneId: "w1:p1", query: "src/u" }], asked.state).state;
    expect(play([{ type: "search-files", seq }], typed).effects).toEqual([]);
    expect(play([{ type: "files-found", seq, files: ["src/a.ts"] }], typed).state.completions.files.list).toEqual([]);
    expect(play([{ type: "files-found", seq: typed.completions.files.seq, files: ["src/ui/b.ts"] }], typed).state.completions.files.list).toEqual(["src/ui/b.ts"]);
    // no file being named: nothing listed, nothing searched
    expect(play([{ type: "file-query", machineId: "local", paneId: "w1:p1", query: null }], typed)).toMatchObject({ effects: [], state: { completions: { files: { list: [] } } } });
  });

  it("shows another pane's composer none of this pane's files", () => {
    const asked = play([{ type: "file-query", machineId: "local", paneId: "w1:p1", query: "ui" }]).state;
    const found = play([{ type: "files-found", seq: asked.completions.files.seq, files: ["src/ui/a.ts"] }], asked).state;
    expect(play([{ type: "file-query", machineId: "local", paneId: "w1:p2", query: "x" }], found).state.completions.files.list).toEqual([]);
  });

    it("counts each slash command used, kept on this device", () => {
    const used = play([{ type: "slash-used", name: "review" }, { type: "slash-used", name: "review" }]);
    expect(used.state.completions.slashUsage).toEqual({ review: 2 });
    expect(used.effects.at(-1)).toEqual({ kind: "save-slash-usage", usage: { review: 2 } });
  });
});

describe("files attached to a composer's message", () => {
  const owner = "w1:p1";
  const file = (name: string) => new File(["x"], name, { type: "image/png" });
  const attach = (names: string[], from = INITIAL_STATE) => play([{ type: "attach-files", owner, machineId: "local", paneId: "w1:p1", files: names.map(file) }], from);

  it("uploads attached files one after another, the next once the one before answered", () => {
    const { state, effects } = attach(["a.png", "b.png"]);
    const [a, b] = state.attachments.lists[owner]!;
    expect([a!.state, b!.state]).toEqual(["uploading", "uploading"]);
    expect(effects).toEqual([{ kind: "upload-file", owner, id: a!.id, machineId: "local", paneId: "w1:p1", file: a!.file }]);
    const done = play([{ type: "upload-done", owner, id: a!.id, path: "/tmp/a.png" }], state);
    expect(done.state.attachments.lists[owner]![0]).toMatchObject({ state: "ready", path: "/tmp/a.png" });
    expect(done.effects).toEqual([{ kind: "upload-file", owner, id: b!.id, machineId: "local", paneId: "w1:p1", file: b!.file }]);
    const failed = play([{ type: "upload-failed", owner, id: b!.id, message: "too large" }], done.state);
    expect(failed.state.attachments.lists[owner]![1]).toMatchObject({ state: "error", error: "too large" });
    expect(failed.effects).toEqual([]);
  });

  it("uploads files attached meanwhile beside the batch under way, each batch one after another", () => {
    const first = attach(["a.png", "b.png"]).state;
    const more = attach(["c.png"], first);
    const c = more.state.attachments.lists[owner]![2]!;
    expect(more.effects).toEqual([expect.objectContaining({ kind: "upload-file", id: c.id })]);
    // the first batch's next waits for its own first
    expect(play([{ type: "upload-done", owner, id: c.id, path: "/tmp/c.png" }], more.state).effects).toEqual([]);
  });

  it("ignores an upload a closed composer started once files are attached there again", () => {
    const { state } = attach(["a.png"]);
    const [a] = state.attachments.lists[owner]!;
    const again = attach(["b.png"], play([{ type: "attachments-close", owner }], state).state).state;
    const late = play([{ type: "upload-done", owner, id: a!.id, path: "/tmp/a.png" }], again);
    expect(late.state).toBe(again);
    expect(late.effects).toEqual([]);
  });

  it("drops a removed file, ignoring its upload's answer, and goes on with the next", () => {
    const { state } = attach(["a.png", "b.png"]);
    const [a, b] = state.attachments.lists[owner]!;
    const removed = play([{ type: "remove-attachment", owner, id: a!.id }], state).state;
    expect(removed.attachments.lists[owner]!.map((item) => item.id)).toEqual([b!.id]);
    const answered = play([{ type: "upload-done", owner, id: a!.id, path: "/tmp/a.png" }], removed);
    expect(answered.state.attachments.lists[owner]!.map((item) => item.state)).toEqual(["uploading"]);
    expect(answered.effects).toEqual([expect.objectContaining({ kind: "upload-file", id: b!.id })]);
  });

  it("lets the files a message took go with it, and forgets them all when the composer goes", () => {
    const { state } = attach(["a.png", "b.png"]);
    const [a] = state.attachments.lists[owner]!;
    expect(play([{ type: "attachments-sent", owner, ids: [a!.id] }], state).state.attachments.lists[owner]!.length).toBe(1);
    const closed = play([{ type: "attachments-close", owner }], state);
    expect(closed.state.attachments.lists[owner]).toBeUndefined();
    // the upload under way answers to nothing, and starts nothing
    expect(play([{ type: "upload-done", owner, id: a!.id, path: "/tmp/a.png" }], closed.state).effects).toEqual([]);
  });
});

describe("answering the waiting prompt in its card", () => {
  const prompt = (id: string, extra: Partial<InteractivePrompt> = {}): InteractivePrompt => ({
    id, agent: "claude", kind: "approval", title: "Allow?", question: "Edit?", body: null, options: [{ label: "Yes", description: null }, { label: "No", description: null }], multi_select: false, custom_option_index: null, ...extra,
  });
  const shown = (extra: Partial<InteractivePrompt> = {}): UiState => {
    const live = play([{ type: "pane-attached", paneId: "w1:p1" }, { type: "pane-connection", connected: true }, { type: "chat-open", machineId: "local", paneId: "w1:p1" }, { type: "chat-agent", paneId: "w1:p1", agent: true }]).state;
    return play([{ type: "chat-prompt-read", seq: live.chat.promptSeq, sent: 0, prompt: prompt("p", extra), suggestion: null }], live).state;
  };
  const answer = (state: UiState, typed = false) => play([{ type: "prompt-card-answer", machineId: "local", paneId: "w1:p1", promptId: "p", answer: { option_index: 0 }, typed }], state);
  const kinds = (effects: Effect[]) => effects.map((effect) => effect.kind);

  it("sends the option picked, holding the card while it goes", () => {
    const { state, effects } = answer(shown());
    expect(effects).toEqual([{ kind: "answer-prompt", id: state.sends.seq, machineId: "local", paneId: "w1:p1", promptId: "p", answer: { option_index: 0 } }]);
    expect(state.chat.card).toEqual({ promptId: "p", status: "pending" });
    // a second while it goes goes nowhere
    expect(answer(state).effects).toEqual([]);
  });

  it("drops the answered prompt", () => {
    const sending = answer(shown()).state;
    const done = play([{ type: "answer-result", id: sending.sends.seq, outcome: { kind: "ok" } }], sending);
    expect(done.state.chat).toMatchObject({ prompt: null, card: null });
    expect(done.effects).toEqual([]);
    // a typed pick for the prompt goes with it, even when another button answered
    const picked = answer(play([{ type: "chat-pending-answer", promptId: "p", answer: { option_index: 1 } }], shown()).state).state;
    expect(play([{ type: "answer-result", id: picked.sends.seq, outcome: { kind: "ok" } }], picked).state.chat.pendingAnswer).toBeNull();
  });

  it("says the prompt changed for a while and reads it again; any other failure says why", () => {
    const sending = answer(shown()).state;
    const changed = play([{ type: "answer-result", id: sending.sends.seq, outcome: { kind: "failed", status: 409, code: "prompt_changed", message: "changed" } }], sending);
    expect(changed.state.chat.card).toMatchObject({ promptId: "p", status: "changed" });
    expect(kinds(changed.effects)).toEqual(["load-chat-prompt", "later"]);
    // the read anew ends the chain before: a read begun earlier answers too late
    expect(play([{ type: "chat-prompt-read", seq: sending.chat.promptSeq, sent: 0, prompt: prompt("q"), suggestion: null }], changed.state).state.chat.prompt?.id).toBe("p");
    const later = changed.effects.find((effect) => effect.kind === "later") as Extract<Effect, { kind: "later" }>;
    expect(later.ms).toBe(CARD_CHANGED_MS);
    expect(play([later.event], changed.state).state.chat.card).toBeNull();
    const failed = play([{ type: "answer-result", id: sending.sends.seq, outcome: { kind: "failed", status: 500, code: null, message: "boom" } }], sending);
    expect(failed.state.chat.card).toEqual({ promptId: "p", status: "failed", message: "boom" });
  });

  it("answers only the prompt the open pane shows", () => {
    const state = shown();
    expect(play([{ type: "prompt-card-answer", machineId: "local", paneId: "w1:p1", promptId: "q", answer: { option_index: 0 }, typed: false }], state).effects).toEqual([]);
    expect(play([{ type: "prompt-card-answer", machineId: "local", paneId: "w1:p2", promptId: "p", answer: { option_index: 0 }, typed: false }], state).effects).toEqual([]);
    expect(play([{ type: "prompt-card-answer", machineId: "remote", paneId: "w1:p1", promptId: "p", answer: { option_index: 0 }, typed: false }], state).effects).toEqual([]);
  });

  it("keeps an answer that lands after another pane opened off that pane, and holds the card when its pane comes back", () => {
    const sending = answer(shown()).state;
    const away = play([{ type: "chat-open", machineId: "local", paneId: "w1:p2" }], sending).state;
    const other = play([{ type: "chat-prompt-read", seq: away.chat.promptSeq, sent: 0, prompt: prompt("p"), suggestion: null }], away).state;
    expect(other.chat.card).toBeNull();
    for (const outcome of [{ kind: "ok" as const }, { kind: "failed" as const, status: 409, code: "prompt_changed", message: "changed" }, { kind: "failed" as const, status: 500, code: null, message: "boom" }]) {
      const landed = play([{ type: "answer-result", id: sending.sends.seq, outcome }], other);
      expect(landed.state.chat).toEqual(other.chat);
      expect(landed.effects).toEqual([]);
    }
    // back before it lands: the card is held, and a second answer goes nowhere
    const back = play([{ type: "chat-open", machineId: "local", paneId: "w1:p1" }], sending).state;
    expect(back.chat.card).toEqual({ promptId: "p", status: "pending" });
    const again = play([{ type: "chat-prompt-read", seq: back.chat.promptSeq, sent: 0, prompt: prompt("p"), suggestion: null }], back).state;
    expect(again.chat.card).toEqual({ promptId: "p", status: "pending" });
    expect(answer(again).effects).toEqual([]);
  });

  it("lets a new prompt be answered while the one before is still on its way, and drops what the card said of the one before", () => {
    const sending = answer(shown()).state;
    const moved = play([{ type: "chat-prompt-read", seq: sending.chat.promptSeq, sent: 0, prompt: prompt("q"), suggestion: null }], sending).state;
    expect(moved.chat.card).toBeNull();
    const landed = play([{ type: "answer-result", id: sending.sends.seq, outcome: { kind: "ok" } }], moved).state;
    expect(landed.chat.prompt?.id).toBe("q");
    expect(play([{ type: "prompt-card-answer", machineId: "local", paneId: "w1:p1", promptId: "q", answer: { option_index: 0 }, typed: false }], moved).effects.map((effect) => effect.kind)).toEqual(["answer-prompt"]);
    const failed = play([{ type: "answer-result", id: sending.sends.seq, outcome: { kind: "failed", status: 500, code: null, message: "boom" } }], sending).state;
    expect(play([{ type: "chat-prompt-read", seq: failed.chat.promptSeq, sent: 0, prompt: prompt("q"), suggestion: null }], failed).state.chat.card).toBeNull();
  });

  it("ends the word that the prompt changed only for its own answer", () => {
    const sending = answer(shown()).state;
    const changed = play([{ type: "answer-result", id: sending.sends.seq, outcome: { kind: "failed", status: 409, code: "prompt_changed", message: "changed" } }], sending);
    const later = changed.effects.find((effect) => effect.kind === "later") as Extract<Effect, { kind: "later" }>;
    // the prompt read again is the same one, answered again and refused again: the first clear is too late
    const reread = play([{ type: "chat-prompt-read", seq: changed.state.chat.promptSeq, sent: 0, prompt: prompt("p"), suggestion: null }], changed.state).state;
    const second = answer(reread).state;
    const again = play([{ type: "answer-result", id: second.sends.seq, outcome: { kind: "failed", status: 409, code: "prompt_changed", message: "changed" } }], second).state;
    expect(play([later.event], again).state.chat.card).toMatchObject({ status: "changed" });
  });

  it("lets go of a typed pick once its Confirm answered, whatever came of it", () => {
    const picked = play([{ type: "chat-pending-answer", promptId: "p", answer: { option_index: 0 } }], shown()).state;
    const sending = answer(picked, true).state;
    expect(sending.chat.pendingAnswer).not.toBeNull();
    const failed = play([{ type: "answer-result", id: sending.sends.seq, outcome: { kind: "failed", status: 500, code: null, message: "boom" } }], sending);
    expect(failed.state.chat.pendingAnswer).toBeNull();
  });
});
