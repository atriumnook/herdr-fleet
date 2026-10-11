import { describe, expect, it } from "bun:test";
import type { AgentRun, FleetSettings, UsageEntry } from "../../shared/fleet.ts";
import type { PairedDevice, RemoteAccess, ServerMessage } from "../../shared/protocol.ts";
import type { Settings } from "../lib/settings.ts";
import { Mediator, type EffectPorts, type PaneSocketHandle, type TerminalSink } from "./mediator.ts";
import { INITIAL_STATE, type RequestAction } from "./state.ts";

const run: AgentRun = { id: "a", name: "impl", role: "worker", agent: "pi", group: "g1", herdrName: "h", paneId: "w1:p1", cwd: "/w", state: "working", depth: 1, interactive: false, worktree: false, startedAt: 1, updatedAt: 1 };
const access: RemoteAccess = { port: 7000, tailscale: { state: "running", dns_name: "pc.tail.ts.net", serving_url: "https://pc.tail.ts.net", serve_command: null, serve_url: null } };
const SETTINGS: FleetSettings = { file: "/c/fleet.json", roles: [], maxUsedPercent: 90, rateLimitCooldownMinutes: 60, maxConcurrent: 6, closeOnSettle: true, projects: [], readOnlyAgents: ["claude"] };
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
    loadLandingDiff: async (runId) => ({ diff: `diff of ${runId}`, truncated: false }),
    loadLandingChecks: async () => ({ baseBranch: "main", uncommitted: [], ahead: 1, behind: 0 }),
    loadFleetSettings: async () => SETTINGS,
    saveFleetSettings: async () => ({ ...SETTINGS, maxConcurrent: 3 }),
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
    requestPermission: async () => "granted",
    subscribePush: async () => "https://push.example/1",
    confirmPush: async () => {},
    removePush: async () => {},
    notifyPane: () => {},
    gatePair: async () => "ok",
    gateAuthenticate: async () => "refused",
    loadAgentKinds: async () => [],
    loadRecent: () => [],
    rememberPane: () => {},
    rememberedAgent: () => "",
    rememberAgent: () => {},
    createSession: async () => ({ workspace_id: "w9", pane_id: "w9:p1", agent_started: true }),
    openPaneSocket: () => { throw new Error("no pane socket in this test"); },
    loadPromptState: async () => ({ prompt: null, suggestion: null }),
    changeQueue: () => ({ messages: [], unsaved: false }),
    answerPrompt: async () => {},
    uploadFile: async (_machineId, _paneId, file) => `/tmp/${file.name}`,
    loadCommands: async () => [],
    loadSlashUsage: () => ({}),
    saveSlashUsage: () => {},
    searchFiles: async () => [],
    changeComposerDraft: () => ({ text: "", sending: false, settled: null }),
    changeLineDraft: () => ({ text: "", sending: false }),
    readConversation: async () => ({ kind: "ok", conversation: { source: "claude-transcript", history_id: "h1", cursor: null, turns: [] } }),
    conversationBetween: async () => [],
    readScrollback: async () => ({ text: "", truncated: false }),
    loadDraft: () => ({ text: "", droppedSpecial: 0 }),
    saveDraft: () => {},
    listFolders: async (_machineId, path) => ({ path: path || "/home/me", parent: "/", home: "/home/me", directories: [], truncated: false }),
    showPreview: () => {},
    leavePreview: () => true,
    loadFileInfo: async () => ({ kind: "missing" }),
    loadFileText: async () => "",
    listFolder: async () => { throw new Error("not a folder"); },
  };
  return { ports: { ...base, ...overrides }, requests, saved, forgotten, timers };
}

/** this browser is in: the server reads its files */
const inside = { ...INITIAL_STATE, connection: { ...INITIAL_STATE.connection, locked: false } };

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

  it("brings what the chat beside asked for back to it, and what the pane's asked for to the pane's", async () => {
    const read: string[] = [];
    const { ports: p } = ports({
      readConversation: async (_machineId, paneId) => {
        read.push(paneId);
        return { kind: "ok", conversation: { source: "claude-transcript", history_id: paneId, cursor: null, turns: [{ role: "user", ts: "1", parts: [{ kind: "text", text: paneId }] }] } };
      },
    });
    const mediator = new Mediator(p);
    mediator.dispatch({ type: "chat-open", machineId: "local", paneId: "w1:p1" });
    mediator.dispatch({ type: "chat-open", machineId: "local", paneId: "w1:p2", lens: "side" });
    await until(() => mediator.getState().side.conversation.loaded && mediator.getState().conversation.loaded);
    expect(mediator.getState().conversation.view.turns[0]!.parts).toEqual([{ kind: "text", text: "w1:p1" }]);
    expect(mediator.getState().side.conversation.view.turns[0]!.parts).toEqual([{ kind: "text", text: "w1:p2" }]);
    expect(read.sort()).toEqual(["w1:p1", "w1:p2"]);
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

  it("turns alerts on: the permission, the subscription, then the confirmation push", async () => {
    const confirmed: string[] = [];
    const mediator = new Mediator(ports({ confirmPush: async (endpoint) => { confirmed.push(endpoint); } }).ports, { ...INITIAL_STATE, settings: { ...INITIAL_STATE.settings, alertsOn: false } });
    mediator.dispatch({ type: "enable-alerts" });
    await until(() => mediator.getState().alerts.push);
    expect(mediator.getState().settings.alertsOn).toBe(true);
    expect(confirmed).toEqual(["https://push.example/1"]);
  });

  it("selects the pane a tapped tab alert is about", () => {
    let tap: (() => void) | null = null;
    const mediator = new Mediator(ports({ notifyPane: (_alert, open) => { tap = open; } }).ports);
    mediator.dispatch({ type: "machines-pushed", machines: [{ id: "local", name: "pc", kind: "local", enabled: true, state: "connected", error: null, snapshot: { version: "x", protocol: 1, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null, workspaces: [], tabs: [], agents: [], panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "idle" }] } as never }] });
    mediator.dispatch({ type: "machine-message", machineId: "local", message: { type: "pane-status", pane_id: "w1:p1", agent_status: "blocked" }, at: 1 });
    expect(tap).not.toBeNull();
    tap!();
    expect(mediator.getState().selection).toMatchObject({ machineId: "local", paneId: "w1:p1" });
  });

  it("reports turning alerts on again as failed when the browser throws for the permission", async () => {
    const mediator = new Mediator(ports({ requestPermission: async () => { throw new Error("old browser"); } }).ports);
    mediator.dispatch({ type: "open-settings" });
    mediator.dispatch({ type: "repair-alerts" });
    await until(() => mediator.getState().pushTest === "failed");
  });

  it("opens the pane a new session made, and says a folder that is not there", async () => {
    const mediator = new Mediator(ports().ports);
    mediator.dispatch({ type: "open-new-session", machineId: "local", defaultCwd: null });
    mediator.dispatch({ type: "submit-new-session" });
    await until(() => mediator.getState().selection.paneId === "w9:p1");
    expect(mediator.getState().newSession.open).toBe(false);
    const missing = new Mediator(ports({ createSession: async () => "invalid-cwd" }).ports);
    missing.dispatch({ type: "open-new-session", machineId: "local", defaultCwd: "/nope" });
    missing.dispatch({ type: "submit-new-session" });
    await until(() => { const dialog = missing.getState().newSession; return dialog.open && dialog.error !== null; });
    expect(missing.getState().newSession).toMatchObject({ error: { kind: "invalid-cwd" }, status: "editing" });
  });

  it("shows the panes opened last as the palette opens, not a frame later", () => {
    const mediator = new Mediator(ports({ loadRecent: () => ["w1:p2", "w1:p1"] }).ports);
    mediator.dispatch({ type: "open-palette" });
    expect(mediator.getState().palette).toMatchObject({ open: true, recent: ["w1:p2", "w1:p1"] });
  });

  it("reads a file the viewer opens, then the start of its text; a read that throws says the file could not be opened", async () => {
    const shown: Array<{ path: string; replace: boolean }> = [];
    const mediator = new Mediator(ports({
      showPreview: (preview, replace) => { shown.push({ path: preview.path, replace }); },
      loadFileInfo: async (_machineId, path) => ({ kind: "info", info: { path: `/w/${path}`, name: path, size: 5, modified: "", mime: "text/plain", kind: "text" } }),
      loadFileText: async (_machineId, path) => `text of ${path}`,
    }).ports, inside);
    mediator.dispatch({ type: "open-file", path: "notes.txt" });
    expect(shown).toEqual([{ path: "notes.txt", replace: false }]);
    await until(() => { const content = mediator.getState().files.viewer?.content; return content?.kind === "file" && content.text !== null; });
    expect(mediator.getState().files.viewer?.content).toMatchObject({ text: "text of /w/notes.txt" });
    const failing = new Mediator(ports({ loadFileInfo: async () => { throw new Error("500"); } }).ports, inside);
    failing.dispatch({ type: "open-file", path: "notes.txt" });
    await until(() => failing.getState().files.viewer?.content.kind === "failed");
    expect(failing.getState().files.viewer?.content).toEqual({ kind: "failed", reason: "failed" });
  });

  it("lists the folder at a path no file is at", async () => {
    const mediator = new Mediator(ports({ listFolder: async () => "/w/src" }).ports, inside);
    mediator.dispatch({ type: "open-file", path: "src" });
    await until(() => mediator.getState().files.viewer?.content.kind === "folder");
    const missing = new Mediator(ports().ports, inside);
    missing.dispatch({ type: "open-file", path: "src" });
    await until(() => missing.getState().files.viewer?.content.kind === "failed");
    expect(missing.getState().files.viewer?.content).toEqual({ kind: "failed", reason: "missing" });
  });

  it("closes a viewer whose history entry is not its own at once, rather than leaving the page", () => {
    const left: number[] = [];
    const mediator = new Mediator(ports({ leavePreview: () => { left.push(1); return false; } }).ports, inside);
    mediator.dispatch({ type: "open-file", path: "notes.txt" });
    mediator.dispatch({ type: "close-file" });
    expect(left).toEqual([1]);
    expect(mediator.getState().files.viewer).toBeNull();
  });

  it("lists a folder browser's folder, and names why one was not listed", async () => {
    const mediator = new Mediator(ports().ports);
    mediator.dispatch({ type: "open-folders", slot: "files", owner: 1, machineId: "local", start: "/w", files: true });
    await until(() => mediator.getState().folders.open.files?.listing !== null);
    expect(mediator.getState().folders.open.files?.listing?.path).toBe("/w");
    const old = new Mediator(ports({ listFolders: async () => ({ failure: "unsupported" }) }).ports);
    old.dispatch({ type: "open-folders", slot: "files", owner: 1, machineId: "pc2", start: "/w", files: true });
    await until(() => old.getState().folders.open.files?.error === "unsupported");
    const failing = new Mediator(ports({ listFolders: async () => { throw new Error("500"); } }).ports);
    failing.dispatch({ type: "open-folders", slot: "files", owner: 1, machineId: "local", start: "/w", files: true });
    await until(() => failing.getState().folders.open.files?.error === "failed");
  });

  describe("the terminal's socket", () => {
    /** a socket the test speaks for: what it was asked, and its connection */
    function fakeSocket() {
      const calls: string[] = [];
      let on: { message(message: ServerMessage): void; disconnected(): void } | null = null;
      const socket: PaneSocketHandle & { up: boolean } = {
        up: false,
        get connected() { return this.up; },
        attach: (paneId) => { calls.push(`attach ${paneId}`); },
        detach: (paneId) => { calls.push(`detach ${paneId}`); },
        resize: (paneId, cols, rows, force) => { calls.push(`resize ${paneId} ${cols}x${rows}${force ? " force" : ""}`); },
        keepSize: (paneId) => { calls.push(`keep-size ${paneId}`); },
        setMode: (role) => { calls.push(`mode ${role}`); },
        canInput: () => socket.up,
        sendInput: (paneId, text) => { calls.push(`input ${paneId} ${text}`); return socket.up; },
        submit: () => null,
        sendSecret: () => null,
        outputAcknowledgement: () => () => { calls.push("ack"); },
        close: () => { calls.push("close"); },
      };
      const opened: string[] = [];
      const port = (machineId: string, handlers: { message(message: ServerMessage): void; disconnected(): void }) => { opened.push(machineId); on = handlers; return socket; };
      return { socket, calls, opened, port, say: (message: ServerMessage) => on!.message(message), drop: () => on!.disconnected() };
    }
    const sinkFor = () => {
      const seen: string[] = [];
      const sink: TerminalSink = {
        output: (message, acknowledge) => { seen.push(`output ${message.data}`); acknowledge?.(); },
        message: (message) => { seen.push(message.type); },
        disconnected: () => { seen.push("disconnected"); },
      };
      return { seen, sink };
    };

    it("opens the socket for the terminal's PC, and hands its commands over", () => {
      const fake = fakeSocket();
      const mediator = new Mediator(ports({ openPaneSocket: fake.port }).ports);
      mediator.dispatch({ type: "open-pane-socket", machineId: "pc2" });
      expect(fake.opened).toEqual(["pc2"]);
      mediator.dispatch({ type: "pane-command", machineId: "pc2", command: { kind: "attach", paneId: "w1:p1", cols: 80, rows: 24, keepSize: false } });
      mediator.dispatch({ type: "pane-command", machineId: "pc2", command: { kind: "resize", paneId: "w1:p1", cols: 100, rows: 30, force: true } });
      mediator.dispatch({ type: "pane-command", machineId: "local", command: { kind: "detach", paneId: "w1:p1" } });
      mediator.dispatch({ type: "close-pane-socket", machineId: "pc2" });
      expect(fake.calls).toEqual(["attach w1:p1", "resize w1:p1 100x30 force", "close"]);
    });

    it("writes the pane's output to the terminal past the state, and tells the state what the socket said", () => {
      const fake = fakeSocket();
      const mediator = new Mediator(ports({ openPaneSocket: fake.port }).ports);
      const { seen, sink } = sinkFor();
      const detach = mediator.attachTerminal(sink);
      mediator.dispatch({ type: "open-pane-socket", machineId: "local" });
      mediator.dispatch({ type: "pane-attached", paneId: "w1:p1" });
      fake.socket.up = true;
      const before = mediator.getState();
      fake.say({ type: "pty-data", pane_id: "w1:p1", data: "hello" } as ServerMessage);
      expect(seen).toEqual(["output hello"]);
      expect(fake.calls).toEqual(["ack"]);
      // the output itself changes nothing the state keeps; the connection and the input do
      expect(mediator.getState().pane).toMatchObject({ connected: true, session: { inputReady: true } });
      expect(before.pane.session.outputReady).toBe(false);
      expect(mediator.getState().pane.session.outputReady).toBe(false);
      fake.say({ type: "error", code: "attach_held", message: "held" } as ServerMessage);
      expect(mediator.getState().pane.session.held).toBe(true);
      fake.say({ type: "role-ack", mode: "observe" } as ServerMessage);
      expect(mediator.getState().pane.role).toBe("observe");
      fake.say({ type: "pty-exit", pane_id: "w1:p1", code: 0 } as ServerMessage);
      expect(mediator.getState().pane.session.ended).toBe(true);
      expect(seen).toEqual(["output hello", "error", "role-ack", "pty-exit"]);
      fake.drop();
      expect(seen.at(-1)).toBe("disconnected");
      expect(mediator.getState().pane.connected).toBe(false);
      detach();
    });

    it("says an output that stopped, and leaves the connection as the stop left it", () => {
      const fake = fakeSocket();
      const mediator = new Mediator(ports({ openPaneSocket: fake.port }).ports);
      mediator.dispatch({ type: "open-pane-socket", machineId: "local" });
      mediator.dispatch({ type: "pane-attached", paneId: "w1:p1" });
      fake.socket.up = true;
      fake.say({ type: "pty-data", pane_id: "w1:p1", data: "x" } as ServerMessage);
      fake.say({ type: "error", code: "output_stalled", message: "could not keep up", pane_id: "w1:p1" } as ServerMessage);
      expect(mediator.getState().pane).toMatchObject({ connected: false, outputStopped: true, session: { ended: true, outputError: "could not keep up" } });
    });

    it("tells the state only what is said of the attached pane, and writes an unknown error in the grid", () => {
      const fake = fakeSocket();
      const mediator = new Mediator(ports({ openPaneSocket: fake.port }).ports);
      const { seen, sink } = sinkFor();
      mediator.attachTerminal(sink);
      mediator.dispatch({ type: "open-pane-socket", machineId: "local" });
      mediator.dispatch({ type: "pane-attached", paneId: "w1:p1" });
      // another pane's output and waits say nothing of this one, nor read the connection (each message reads its input, as before)
      fake.socket.up = true;
      fake.say({ type: "pty-data", pane_id: "w1:p9", data: "x" } as ServerMessage);
      fake.say({ type: "error", code: "attach_held", message: "held", pane_id: "w1:p9" } as ServerMessage);
      fake.say({ type: "error", code: "terminal_unsupported", message: "no", pane_id: "w1:p9" } as ServerMessage);
      expect(mediator.getState().pane.session).toMatchObject({ outputReady: false, held: false, unsupported: false, ended: false });
      expect(mediator.getState().pane.connected).toBe(false);
      fake.say({ type: "error", code: "terminal_unsupported", message: "no" } as ServerMessage);
      expect(mediator.getState().pane.session.unsupported).toBe(true);
      fake.say({ type: "error", code: "input_failed", message: "not taken", pane_id: "w1:p1" } as ServerMessage);
      expect(mediator.getState().pane.session.inputError).toBe("not taken");
      fake.say({ type: "error", code: "something_new", message: "odd" } as ServerMessage);
      expect(seen.at(-1)).toBe("error");
      expect(mediator.getState().pane.connected).toBe(true);
      fake.say({ type: "error", code: "attach_conflict", message: "taken over" } as ServerMessage);
      expect(mediator.getState().pane).toMatchObject({ connected: false, outputStopped: false, session: { ended: true, outputError: "taken over" } });
    });

    it("closes the socket before when another opens, and hears nothing more from it", () => {
      const first = fakeSocket();
      const second = fakeSocket();
      let opening = 0;
      const mediator = new Mediator(ports({ openPaneSocket: (machineId, on) => (opening++ === 0 ? first.port : second.port)(machineId, on) }).ports);
      mediator.dispatch({ type: "open-pane-socket", machineId: "local" });
      mediator.dispatch({ type: "open-pane-socket", machineId: "pc2" });
      expect(first.calls).toEqual(["close"]);
      mediator.dispatch({ type: "pane-attached", paneId: "w1:p1" });
      second.socket.up = true;
      second.say({ type: "pty-data", pane_id: "w1:p1", data: "x" } as ServerMessage);
      expect(mediator.getState().pane.connected).toBe(true);
      first.drop();
      first.say({ type: "pty-exit", pane_id: "w1:p1", code: 0 } as ServerMessage);
      expect(mediator.getState().pane.connected).toBe(true);
      expect(mediator.getState().pane.session.ended).toBe(false);
    });

    it("sends the held input once the terminal takes it, and keeps it when the socket does not", () => {
      const fake = fakeSocket();
      const saved: Array<{ owner: string; text: string }> = [];
      const mediator = new Mediator(ports({ openPaneSocket: fake.port, loadDraft: () => ({ text: "ls", droppedSpecial: 0 }), saveDraft: (owner, value) => { saved.push({ owner, text: value.text }); } }).ports);
      mediator.dispatch({ type: "open-pane-socket", machineId: "local" });
      mediator.dispatch({ type: "pane-attached", paneId: "w1:p1" });
      mediator.dispatch({ type: "draft-open", owner: "w1:p1" });
      expect(mediator.getState().pane.draft.value.text).toBe("ls");
      fake.socket.up = true;
      fake.say({ type: "pty-data", pane_id: "w1:p1", data: "$" } as ServerMessage);
      // taken by nothing: it stays
      fake.socket.sendInput = () => false;
      mediator.dispatch({ type: "send-draft" });
      expect(mediator.getState().pane.draft.value.text).toBe("ls");
      fake.socket.sendInput = (paneId, text) => { fake.calls.push(`input ${paneId} ${text}`); return true; };
      mediator.dispatch({ type: "send-draft" });
      expect(fake.calls.at(-1)).toBe("input w1:p1 ls");
      expect(mediator.getState().pane.draft.value.text).toBe("");
      expect(saved.at(-1)).toEqual({ owner: "w1:p1", text: "" });
    });

        it("acknowledges output with no terminal to write it, so the server is not left waiting", () => {
      const fake = fakeSocket();
      const mediator = new Mediator(ports({ openPaneSocket: fake.port }).ports);
      mediator.dispatch({ type: "open-pane-socket", machineId: "local" });
      fake.say({ type: "pty-data", pane_id: "w1:p1", data: "x" } as ServerMessage);
      expect(fake.calls).toEqual(["ack"]);
    });

    it("hears nothing more from a socket it closed, and reads the connection once a second while open", () => {
      const fake = fakeSocket();
      const { ports: p, timers } = ports({ openPaneSocket: fake.port });
      const mediator = new Mediator(p);
      mediator.dispatch({ type: "open-pane-socket", machineId: "local" });
      mediator.dispatch({ type: "pane-attached", paneId: "w1:p1" });
      fake.socket.up = true;
      const poll = timers.find((timer) => timer.ms === 1000)!;
      poll.then();
      expect(mediator.getState().pane.connected).toBe(true);
      mediator.dispatch({ type: "close-pane-socket", machineId: "local" });
      fake.say({ type: "pty-exit", pane_id: "w1:p1", code: 0 } as ServerMessage);
      expect(mediator.getState().pane.session.ended).toBe(false);
      const after = timers.length;
      timers.at(-1)!.then();
      expect(timers.length).toBe(after);
    });

    it("submits a message on the socket and says what came of it: taken, not sent with no socket, not confirmed", async () => {
      const fake = fakeSocket();
      const mediator = new Mediator(ports({ openPaneSocket: fake.port }).ports);
      const owner = "w1:p1";
      const ask = () => mediator.dispatch({ type: "composer-send", owner, machineId: "local", paneId: "w1:p1", text: "hi", via: "box", bracketedPaste: false, working: false });
      const outcome = () => mediator.getState().sends.outcomes[`composer:${owner}`]?.outcome;
      ask();
      await until(() => outcome()?.kind === "not-sent");
      mediator.dispatch({ type: "open-pane-socket", machineId: "local" });
      fake.socket.submit = async () => ({ ok: true });
      ask();
      await until(() => outcome()?.kind === "sent");
      expect(mediator.getState().sends.started).toBe(1);
      fake.socket.submit = async () => { throw new Error("closed"); };
      ask();
      await until(() => outcome()?.kind === "unconfirmed");
    });

    it("lends the terminal the socket for its keystrokes, and nothing once it closed", () => {
      const fake = fakeSocket();
      const mediator = new Mediator(ports({ openPaneSocket: fake.port }).ports);
      const link = mediator.terminalLink;
      expect(link.sendInput("w1:p1", "a")).toBe(false);
      mediator.dispatch({ type: "open-pane-socket", machineId: "local" });
      fake.socket.up = true;
      expect(link.connected()).toBe(true);
      expect(link.sendInput("w1:p1", "a")).toBe(true);
      mediator.dispatch({ type: "close-pane-socket", machineId: "local" });
      expect(link.connected()).toBe(false);
      expect(link.sendInput("w1:p1", "b")).toBe(false);
      expect(fake.calls).toEqual(["input w1:p1 a", "close"]);
    });
  });

  it("reads the chat's prompt with the sends counted when the read began, and says a read that failed", async () => {
    const mediator = new Mediator(ports({ loadPromptState: async () => ({ prompt: null, suggestion: "run the tests" }) }).ports, inside);
    mediator.dispatch({ type: "pane-attached", paneId: "w1:p1" });
    mediator.dispatch({ type: "pane-connection", connected: true });
    mediator.dispatch({ type: "chat-open", machineId: "local", paneId: "w1:p1" });
    mediator.dispatch({ type: "chat-agent", paneId: "w1:p1", agent: true });
    await until(() => mediator.getState().chat.suggestion === "run the tests");
    const failing = new Mediator(ports({ loadPromptState: async () => { throw new Error("502"); } }).ports, inside);
    failing.dispatch({ type: "pane-attached", paneId: "w1:p1" });
    failing.dispatch({ type: "pane-connection", connected: true });
    failing.dispatch({ type: "chat-open", machineId: "local", paneId: "w1:p1" });
    failing.dispatch({ type: "chat-agent", paneId: "w1:p1", agent: true });
    await Bun.sleep(5);
    expect(failing.getState().chat.prompt).toBeNull();
  });

  it("makes each change to the held messages in the store, and keeps what it answers", () => {
    const changes: string[] = [];
    const mediator = new Mediator(ports({ changeQueue: (owner, change) => { changes.push(`${owner} ${change.kind}`); return { messages: [{ id: "a", text: "one" }], unsaved: true }; } }).ports);
    mediator.dispatch({ type: "queue-edit", owner: "w1:p1", id: "a", text: "one" });
    expect(changes).toEqual(["w1:p1 edit"]);
    expect(mediator.getState().queue).toMatchObject({ lists: { "w1:p1": [{ id: "a", text: "one" }] }, unsaved: { "w1:p1": true } });
  });
});
