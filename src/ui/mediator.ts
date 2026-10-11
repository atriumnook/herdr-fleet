import type { AgentRun, FleetSettings, FleetSettingsPatch, LandingChecks, UsageEntry } from "../../shared/fleet.ts";
import type { Plan } from "../../shared/plan.ts";
import type { Machine, MachineEvent } from "../../shared/machines.ts";
import type { BridgeHealth } from "../../shared/machines.ts";
import type { PairedDevice, PairingCode, RemoteAccess, SessionSnapshot } from "../../shared/protocol.ts";
import type { HealthInfo } from "../lib/api.ts";
import type { PaneView } from "../lib/actions.ts";
import type { NotificationState } from "../lib/notifications.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { AgentKind, ClientRole, SlashCommand, ConversationTurn, DirectoryListing, HerdrPane, InteractivePrompt, PromptAnswer, ServerMessage, WorkspaceCreated } from "../../shared/protocol.ts";
import type { SubmitResult } from "../lib/ws.ts";
import type { InputDraft } from "../lib/draft.ts";
import type { HeldMessage } from "../lib/messageQueue.ts";
import type { Settings } from "../lib/settings.ts";
import type { FilePreview } from "../lib/fileHistory.ts";
import { INITIAL_STATE, transition, type ComposerDraftChange, type ConversationOutcome, type Effect, type FileOutcome, type LineDraftChange, type QueueChange, type RequestAction, type SessionRequest, type TreeRequest, type UiEvent, type UiState } from "./state.ts";

type PtyData = Extract<ServerMessage, { type: "pty-data" }>;

/** The terminal's socket (lib/ws.ts HerdrSocket), as the Mediator and the terminal use it. */
export interface PaneSocketHandle {
  readonly connected: boolean;
  attach(paneId: string, cols: number, rows: number, keepSize?: boolean): void;
  detach(paneId: string): void;
  resize(paneId: string, cols: number, rows: number, force?: boolean): void;
  keepSize(paneId: string): void;
  setMode(mode: ClientRole): void;
  canInput(paneId: string): boolean;
  sendInput(paneId: string, text: string): boolean;
  submit(paneId: string, text: string, payload: string, typed?: boolean): Promise<SubmitResult> | null;
  sendSecret(paneId: string, prompt: string, secret: string): Promise<SubmitResult> | null;
  outputAcknowledgement(message: PtyData): (() => void) | undefined;
  close(): void;
}

/**
 * The terminal's xterm, as the socket's messages reach it past the state machine: the pane's
 * output (a byte stream the state would only re-render for) with its flow-control
 * acknowledgement, and every other message for what the grid itself does with it.
 */
export interface TerminalSink {
  output(message: PtyData, acknowledge: (() => void) | undefined): void;
  message(message: ServerMessage): void;
  disconnected(): void;
}

/** What the terminal sends straight to its socket: keystrokes, and a secret. Nothing while no socket is open. */
export interface TerminalLink {
  connected(): boolean;
  canInput(paneId: string): boolean;
  sendInput(paneId: string, text: string): boolean;
  /** the one send a view awaits: a secret never enters the state or an event (SecretInput) */
  sendSecret(paneId: string, prompt: string, secret: string): Promise<SubmitResult> | null;
}

/** how often the terminal socket's connection is read, as it can change without a message */
const SOCKET_POLL_MS = 1000;

/** What the Mediator's effects reach: the server's API and this browser's storage, or a test's stand-in. */
export interface EffectPorts {
  loadRuns(): Promise<AgentRun[]>;
  loadUsage(): Promise<UsageEntry[]>;
  refreshUsage(): Promise<UsageEntry[]>;
  runRequest(action: RequestAction): Promise<void>;
  loadLandingDiff(runId: string): Promise<{ diff: string; truncated: boolean }>;
  loadLandingChecks(runId: string): Promise<LandingChecks>;
  loadPlan(runId: string): Promise<Plan>;
  loadFleetSettings(cwd: string | null): Promise<FleetSettings>;
  saveFleetSettings(cwd: string | null, patch: FleetSettingsPatch): Promise<FleetSettings>;
  saveSettings(settings: Settings): void;
  forgetPaneViews(): void;
  loadRemoteAccess(): Promise<RemoteAccess>;
  /** null: the server keeps no devices */
  loadDevices(): Promise<PairedDevice[] | null>;
  startPairing(): Promise<PairingCode>;
  renameDevice(id: string, label: string): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  /** a test push to this device's own subscription; `missing` when the server no longer has it */
  testPush(): Promise<"sent" | "unsupported" | "permission" | "missing">;
  /** a change to a PC's sessions in its herdr (close, rename, reorder) */
  treeRequest(machineId: string, request: TreeRequest): Promise<void>;
  /** this browser's access, as the server's bridge health tells it */
  loadAccess(): Promise<BridgeHealth>;
  loadHealth(): Promise<HealthInfo>;
  /** "unauthorized": the server no longer lets this browser in */
  loadMachines(): Promise<Machine[] | "unauthorized">;
  authenticate(token: string): Promise<void>;
  pairFromAddress(code: string): Promise<void>;
  signOut(): Promise<void>;
  loadSession(machineId: string): Promise<SessionSnapshot>;
  /** opens the stream of every PC's changes; the function returned closes it */
  openStream(on: { opened(): void; event(event: MachineEvent): void }): () => void;
  /** the browser's notification permission, asked for when not yet given */
  requestPermission(): Promise<NotificationState>;
  /** registers this device's push subscription with these alerts; its endpoint, null when push is not there */
  subscribePush(prefs: AlertPrefs): Promise<string | null>;
  /** one push to this endpoint: it proves the whole path to this device */
  confirmPush(endpoint: string): Promise<void>;
  removePush(): Promise<void>;
  /** the tab's own alert; `open` selects the pane when it is tapped */
  notifyPane(alert: { machineId: string; machineName: string; pane: HerdrPane; status: "blocked" | "done" | "ended" }, open: () => void): void;
  /** the access gate's pairing code and token: "refused" when the server does not take it */
  gatePair(code: string): Promise<"ok" | "refused">;
  gateAuthenticate(token: string): Promise<"ok" | "refused">;
  loadAgentKinds(machineId: string): Promise<AgentKind[]>;
  /** the panes opened last on a PC, newest first */
  loadRecent(machineId: string): string[];
  rememberPane(machineId: string, paneId: string): void;
  /** the agent chosen last for a new session on this device */
  rememberedAgent(): string;
  rememberAgent(agentKind: string): void;
  /** "invalid-cwd": the folder is not there */
  createSession(machineId: string, request: SessionRequest): Promise<WorkspaceCreated | "invalid-cwd">;
  /** keeps the lens chosen in a pane on this device */
  storeLens(storageId: string, view: PaneView): void;
  /** keeps the selected pane for this window's next load */
  storeSelection(machineId: string, paneId: string | null): void;
  /** the file in the viewer as a history entry: a new one, or in place of the current one */
  showPreview(preview: FilePreview, replace: boolean): void;
  /** goes Back from the file's history entry; false when the current entry is not a file's */
  leavePreview(): boolean;
  /** what the server says of a path; throws for anything but these */
  loadFileInfo(machineId: string, path: string, paneId: string | null): Promise<Exclude<FileOutcome, { kind: "failed" }>>;
  /** stores a file beside a pane, answering its path */
  uploadFile(machineId: string, paneId: string, file: File): Promise<string>;
  /** a pane's slash commands, kept a while */
  loadCommands(machineId: string, paneId: string): Promise<SlashCommand[]>;
  /** how often each slash command was used on this device */
  loadSlashUsage(): Record<string, number>;
  saveSlashUsage(usage: Record<string, number>): void;
  /** the files under a pane's folder whose path matches what is typed */
  searchFiles(machineId: string, paneId: string, query: string): Promise<string[]>;
  /** answers a pane's waiting prompt with one of its options or its own reply row; throws with `status` 409 when the menu moved on */
  answerPrompt(machineId: string, answer: PromptAnswer): Promise<void>;
  /** changes a pane's composer draft and answers it as now kept, with what a settle left */
  changeComposerDraft(owner: string, change: ComposerDraftChange): { text: string; sending: boolean; settled: { text: string; edited: boolean } | null };
  /** changes a pane's terminal input line and answers it as now kept */
  changeLineDraft(owner: string, change: LineDraftChange): { text: string; sending: boolean };
  /** changes a pane's held messages (reading another tab's first) and answers them as now kept */
  changeQueue(owner: string, change: QueueChange): { messages: HeldMessage[]; unsaved: boolean };
  /** a page of a pane's conversation: the newest (from `from`, when earlier pages show), or the one before `before` */
  readConversation(machineId: string, paneId: string, page: { from: string | null } | { before: string }): Promise<ConversationOutcome>;
  /** the turns between the held start and where the newest page now starts, a page at a time; null when they cannot be joined */
  conversationBetween(machineId: string, paneId: string, held: string, start: string): Promise<ConversationTurn[] | null>;
  /** the pane's scrollback, for an agent with no transcript */
  readScrollback(machineId: string, paneId: string, lines: number): Promise<{ text: string; truncated: boolean }>;
  /** the prompt waiting on a pane, and with none, what its agent suggests typing next */
  loadPromptState(machineId: string, paneId: string): Promise<{ prompt: InteractivePrompt | null; suggestion: string | null }>;
  /** the input held for a pane on this device (lib/draft.ts) */
  loadDraft(owner: string): InputDraft;
  /** keeps it for the next load; an empty one is forgotten */
  saveDraft(owner: string, value: InputDraft): void;
  /** opens the terminal's socket to a PC; its messages and its drops come through `on` */
  openPaneSocket(machineId: string, on: { message(message: ServerMessage): void; disconnected(): void }): PaneSocketHandle;
  /** the folders (and files, when asked) in a folder on a PC; "" is home. Throws for anything but these failures */
  listFolders(machineId: string, path: string, hidden: boolean, files: boolean): Promise<DirectoryListing | { failure: "unsupported" | "invalid" }>;
  /** the start of a text file */
  loadFileText(machineId: string, path: string, paneId: string | null): Promise<string>;
  /** the folder at a path, as listed (absolute) */
  listFolder(machineId: string, path: string, paneId: string | null): Promise<string>;
  /** runs `then` after `ms`: the clock the state machine's `later` effects wait on */
  later(ms: number, then: () => void): void;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The Root's Mediator: every event the views bubble up (and every outcome of its own effects)
 * goes through `dispatch`, the state machine decides, and the effects it names run here. Views
 * read the state through `subscribe` / `getState` (React's useSyncExternalStore) and nothing else.
 */
export class Mediator {
  private state: UiState;
  private readonly listeners = new Set<() => void>();
  private closeStream: (() => void) | null = null;
  /** the terminal's socket open now, by the opening it answers */
  private paneSocket: { seq: number; handle: PaneSocketHandle } | null = null;
  private terminal: TerminalSink | null = null;

  constructor(private readonly ports: EffectPorts, initial: UiState = INITIAL_STATE) {
    this.state = initial;
  }

  getState = (): UiState => this.state;

  /** The terminal's xterm takes the socket's messages until the function returned is called. */
  attachTerminal = (sink: TerminalSink): (() => void) => {
    this.terminal = sink;
    return () => { if (this.terminal === sink) this.terminal = null; };
  };

  readonly terminalLink: TerminalLink = {
    connected: () => this.paneSocket?.handle.connected ?? false,
    canInput: (paneId) => this.paneSocket?.handle.canInput(paneId) ?? false,
    sendInput: (paneId, text) => this.paneSocket?.handle.sendInput(paneId, text) ?? false,
    sendSecret: (paneId, prompt, secret) => this.paneSocket?.handle.sendSecret(paneId, prompt, secret) ?? null,
  };

  /**
   * A message from the terminal's socket: the output goes to the terminal alone; anything else to
   * the terminal too, and as events to the state for what it says of the attached pane.
   */
  private paneMessage(seq: number, message: ServerMessage): void {
    if (this.paneSocket?.seq !== seq) return;
    const { handle } = this.paneSocket;
    const paneId = this.state.pane.session.paneId;
    const connection = (): void => this.dispatch({ type: "pane-connection", connected: handle.connected });
    if (paneId !== null) this.dispatch({ type: "pane-input-ready", paneId, ready: handle.canInput(paneId) });
    if (message.type === "pty-data") {
      const acknowledge = handle.outputAcknowledgement(message);
      // nothing to write it to: the server must not wait on it
      if (this.terminal) this.terminal.output(message, acknowledge); else acknowledge?.();
      if (message.pane_id === paneId) connection();
      return;
    }
    this.terminal?.message(message);
    switch (message.type) {
      case "attach-resumed":
        this.dispatch({ type: "pane-attach-resumed", paneId: message.pane_id });
        break;
      case "pty-exit":
        this.dispatch({ type: "pane-exited", paneId: message.pane_id });
        break;
      case "role-ack":
        this.dispatch({ type: "role-ack", role: message.mode });
        break;
      case "error": {
        const about = message.pane_id ?? paneId;
        if (message.code === "input_not_ready" || message.code === "input_failed") {
          if (message.pane_id !== undefined) this.dispatch({ type: "pane-input-failed", paneId: message.pane_id, message: message.message });
          return;
        }
        if (message.code === "attach_held" || message.code === "terminal_unsupported") {
          // a pane this terminal already left: its wait is not this pane's
          if (about === null || about !== paneId) return;
          this.dispatch({ type: message.code === "attach_held" ? "pane-attach-held" : "pane-terminal-unsupported", paneId: about });
          break;
        }
        if (message.code === "output_stalled" || message.code === "attach_conflict") {
          if (message.code === "output_stalled") this.dispatch({ type: "output-stalled" });
          // the connection stays as the stop left it until the next read of it
          this.dispatch({ type: "pane-output-failed", message: message.message });
          return;
        }
        break;
      }
    }
    connection();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch = (event: UiEvent): void => {
    const { state, effects } = transition(this.state, event);
    if (state !== this.state) {
      this.state = state;
      for (const listener of [...this.listeners]) listener();
    }
    for (const effect of effects) {
      const lens = effect.lens;
      void this.run(effect, lens === undefined ? (event) => this.dispatch(event) : (event) => this.dispatch({ ...event, lens }));
    }
  };

  /** `dispatch`: where what the effect answers goes; an effect of the chat beside answers that chat (`lens`) */
  private async run(effect: Effect, dispatch: (event: UiEvent) => void): Promise<void> {
    switch (effect.kind) {
      case "load-runs":
        try { dispatch({ type: "runs-loaded", runs: await this.ports.loadRuns() }); } catch (error) { dispatch({ type: "runs-failed", message: message(error) }); }
        return;
      case "load-usage":
        try { dispatch({ type: "usage-loaded", entries: await this.ports.loadUsage() }); } catch (error) { dispatch({ type: "usage-failed", message: message(error) }); }
        return;
      case "refresh-usage":
        try { dispatch({ type: "usage-refreshed", entries: await this.ports.refreshUsage() }); } catch (error) { dispatch({ type: "usage-refresh-failed", message: message(error) }); }
        return;
      case "request":
        try { await this.ports.runRequest(effect.action); dispatch({ type: "request-done" }); } catch (error) { dispatch({ type: "request-failed", message: message(error) }); }
        return;
      case "load-landing-diff":
        try { dispatch({ type: "landing-diff-loaded", runId: effect.runId, diff: await this.ports.loadLandingDiff(effect.runId) }); }
        catch (error) { dispatch({ type: "landing-diff-failed", runId: effect.runId, message: message(error) }); }
        return;
      case "load-fleet-settings":
        try { dispatch({ type: "fleet-settings-loaded", settings: await this.ports.loadFleetSettings(effect.cwd) }); }
        catch (error) { dispatch({ type: "fleet-settings-failed", message: message(error) }); }
        return;
      case "save-fleet-settings":
        try { dispatch({ type: "fleet-settings-saved", seq: effect.seq, settings: await this.ports.saveFleetSettings(effect.cwd, effect.patch) }); }
        catch (error) { dispatch({ type: "fleet-settings-save-failed", seq: effect.seq, message: message(error) }); }
        return;
      case "load-landing-checks":
        try { dispatch({ type: "landing-checks-loaded", runId: effect.runId, checks: await this.ports.loadLandingChecks(effect.runId) }); }
        catch (error) { dispatch({ type: "landing-checks-failed", runId: effect.runId, message: message(error) }); }
        return;
      case "load-plan":
        try { dispatch({ type: "plan-loaded", runId: effect.runId, seq: effect.seq, plan: await this.ports.loadPlan(effect.runId) }); }
        catch (error) { dispatch({ type: "plan-failed", runId: effect.runId, seq: effect.seq, message: message(error) }); }
        return;
      case "save-settings":
        this.ports.saveSettings(effect.settings);
        return;
      case "forget-pane-views":
        this.ports.forgetPaneViews();
        return;
      case "load-remote-access":
        try { dispatch({ type: "remote-access-loaded", access: await this.ports.loadRemoteAccess() }); } catch (error) { dispatch({ type: "remote-access-failed", message: message(error) }); }
        return;
      case "load-devices":
        try {
          const devices = await this.ports.loadDevices();
          dispatch(devices === null ? { type: "devices-failed", message: "", unavailable: true, session: effect.session } : { type: "devices-loaded", devices, session: effect.session });
        } catch (error) { dispatch({ type: "devices-failed", message: message(error), unavailable: false, session: effect.session }); }
        return;
      case "start-pairing":
        try { dispatch({ type: "pairing-started", code: await this.ports.startPairing(), at: Date.now(), session: effect.session }); } catch (error) { dispatch({ type: "device-change-failed", message: message(error), session: effect.session }); }
        return;
      case "rename-device":
        try { await this.ports.renameDevice(effect.id, effect.label); dispatch({ type: "device-renamed", session: effect.session }); } catch (error) { dispatch({ type: "device-change-failed", message: message(error), session: effect.session }); }
        return;
      case "revoke-device":
        try { await this.ports.revokeDevice(effect.id); dispatch({ type: "device-changed", session: effect.session }); } catch (error) { dispatch({ type: "device-change-failed", message: message(error), session: effect.session }); }
        return;
      case "test-push":
        try { dispatch({ type: "push-tested", result: await this.ports.testPush(), session: effect.session }); } catch { dispatch({ type: "push-tested", result: "failed", session: effect.session }); }
        return;
      case "tree-request": {
        const { machineId, request, viaConfirm, revert } = effect;
        try { await this.ports.treeRequest(machineId, request); dispatch({ type: "tree-done", machineId, viaConfirm }); }
        catch (error) { dispatch({ type: "tree-failed", machineId, request, reason: message(error), viaConfirm, revert }); }
        return;
      }
      case "load-health":
        try { dispatch({ type: "access-loaded", auth: (await this.ports.loadAccess()).auth }); } catch { /* the gate stays while the server restarts */ }
        try { dispatch({ type: "health-loaded", health: await this.ports.loadHealth() }); } catch { dispatch({ type: "health-failed" }); }
        return;
      case "load-machines":
        try {
          const machines = await this.ports.loadMachines();
          dispatch(machines === "unauthorized" ? { type: "machines-failed", message: "", unauthorized: true, revision: effect.revision } : { type: "machines-loaded", machines, revision: effect.revision });
        } catch (error) { dispatch({ type: "machines-failed", message: message(error), unauthorized: false, revision: effect.revision }); }
        return;
      case "authenticate":
        try { await this.ports.authenticate(effect.token); dispatch({ type: "authenticated", reason: effect.reason }); } catch { dispatch({ type: "authentication-failed", reason: effect.reason }); }
        return;
      case "pair-from-address":
        // the gate, if any, reports a code that failed
        try { await this.ports.pairFromAddress(effect.code); dispatch({ type: "paired-from-address" }); } catch { /* as above */ }
        return;
      case "sign-out":
        try { await this.ports.signOut(); } catch { /* the cookie may still be set: health decides */ }
        dispatch({ type: "signed-out" });
        return;
      case "open-stream":
        this.closeStream?.();
        this.closeStream = this.ports.openStream({
          opened: () => dispatch({ type: "stream-opened" }),
          event: (event) => dispatch(event.type === "machines" ? { type: "machines-pushed", machines: event.machines } : { type: "machine-message", machineId: event.machine_id, message: event.message, at: Date.now() }),
        });
        return;
      case "close-stream":
        this.closeStream?.();
        this.closeStream = null;
        return;
      case "confirm-pane-gone":
        try { dispatch({ type: "pane-session-read", machineId: effect.machineId, paneId: effect.paneId, session: await this.ports.loadSession(effect.machineId) }); }
        catch { dispatch({ type: "pane-session-failed", machineId: effect.machineId, paneId: effect.paneId }); }
        return;
      case "enable-alerts": {
        // an older browser can throw instead of answering: that is no permission
        const permission = await this.ports.requestPermission().catch((): NotificationState => "default");
        dispatch({ type: "alerts-permission", permission });
        let ok = false;
        if (permission === "granted") {
          try {
            const endpoint = await this.ports.subscribePush(effect.prefs);
            dispatch({ type: "push-subscribed", on: endpoint !== null, seq: null });
            if (endpoint !== null) await this.ports.confirmPush(endpoint);
            ok = endpoint !== null;
          } catch (error) {
            console.warn("web push unavailable, alerts stay tab-only", error);
          }
        }
        dispatch({ type: "alerts-enabled", ok, session: effect.session });
        return;
      }
      case "remove-push":
        await this.ports.removePush().catch((error: unknown) => console.warn("could not drop the push subscription", error));
        return;
      case "subscribe-push":
        try { dispatch({ type: "push-subscribed", on: (await this.ports.subscribePush(effect.prefs)) !== null, seq: effect.seq }); }
        catch { dispatch({ type: "push-subscribed", on: false, seq: effect.seq }); }
        return;
      case "notify-pane":
        this.ports.notifyPane(effect, () => dispatch({ type: "select-pane", machineId: effect.machineId, paneId: effect.pane.pane_id }));
        return;
      case "load-agents":
        // the agent chosen last shows at once; the list only checks this PC still has it
        dispatch({ type: "new-session-remembered", agentKind: this.ports.rememberedAgent(), seq: effect.seq });
        try { dispatch({ type: "new-session-agents", agents: await this.ports.loadAgentKinds(effect.machineId), seq: effect.seq }); }
        catch (error) { dispatch({ type: "new-session-agents-failed", message: message(error), seq: effect.seq }); }
        return;
      case "gate-pair":
      case "gate-authenticate": {
        const via = effect.kind === "gate-pair" ? "code" : "token";
        try {
          const answer = effect.kind === "gate-pair" ? await this.ports.gatePair(effect.code) : await this.ports.gateAuthenticate(effect.token);
          dispatch(answer === "ok" ? { type: "gate-passed" } : { type: "gate-failed", via, unauthorized: true, message: "" });
        } catch (error) { dispatch({ type: "gate-failed", via, unauthorized: false, message: message(error) }); }
        return;
      }
      case "load-recent":
        dispatch({ type: "palette-recent", machineId: effect.machineId, recent: this.ports.loadRecent(effect.machineId) });
        return;
      case "remember-pane":
        this.ports.rememberPane(effect.machineId, effect.paneId);
        return;
      case "remember-agent":
        this.ports.rememberAgent(effect.agentKind);
        return;
      case "create-session":
        try {
          const created = await this.ports.createSession(effect.machineId, effect.request);
          if (created === "invalid-cwd") { dispatch({ type: "new-session-failed", message: "", invalidCwd: true, seq: effect.seq }); return; }
          const agentError = effect.request.agent !== null && !created.agent_started ? created.error?.message ?? null : null;
          dispatch({ type: "new-session-created", paneId: created.pane_id, agentError, seq: effect.seq });
        } catch (error) { dispatch({ type: "new-session-failed", message: message(error), invalidCwd: false, seq: effect.seq }); }
        return;
      case "store-lens":
        this.ports.storeLens(effect.storageId, effect.view);
        return;
      case "store-selection":
        this.ports.storeSelection(effect.machineId, effect.paneId);
        return;
      case "history-preview":
        this.ports.showPreview(effect.preview, effect.replace);
        return;
      case "history-back":
        // with no entry of its own to go Back from, Back would leave the page: the viewer just closes
        if (!this.ports.leavePreview()) dispatch({ type: "file-history", preview: null });
        return;
      case "load-file": {
        const { machineId, path, paneId, seq } = effect;
        let outcome: FileOutcome;
        try { outcome = await this.ports.loadFileInfo(machineId, path, paneId); } catch { outcome = { kind: "failed" }; }
        dispatch({ type: "file-loaded", seq, outcome });
        return;
      }
      case "load-file-text":
        try { dispatch({ type: "file-text", seq: effect.seq, text: await this.ports.loadFileText(effect.machineId, effect.path, effect.paneId) }); }
        catch { dispatch({ type: "file-loaded", seq: effect.seq, outcome: { kind: "failed" } }); }
        return;
      case "list-folder":
        // a path that is not a readable folder either keeps the file's error
        try { dispatch({ type: "file-folder", seq: effect.seq, path: await this.ports.listFolder(effect.machineId, effect.path, effect.paneId) }); }
        catch { dispatch({ type: "file-folder", seq: effect.seq, path: null }); }
        return;
      case "list-folders": {
        const { slot, seq } = effect;
        try {
          const listed = await this.ports.listFolders(effect.machineId, effect.path, effect.hidden, effect.files);
          dispatch("failure" in listed ? { type: "folders-failed", slot, seq, reason: listed.failure } : { type: "folders-listed", slot, seq, listing: listed });
        } catch { dispatch({ type: "folders-failed", slot, seq, reason: "failed" }); }
        return;
      }
      case "open-pane-socket": {
        this.paneSocket?.handle.close();
        const { seq } = effect;
        const handle = this.ports.openPaneSocket(effect.machineId, {
          message: (message) => this.paneMessage(seq, message),
          disconnected: () => {
            if (this.paneSocket?.seq !== seq) return;
            this.terminal?.disconnected();
            dispatch({ type: "pane-socket-lost" });
            dispatch({ type: "pane-connection", connected: false });
          },
        });
        this.paneSocket = { seq, handle };
        const poll = (): void => {
          if (this.paneSocket?.seq !== seq) return;
          dispatch({ type: "pane-connection", connected: handle.connected });
          this.ports.later(SOCKET_POLL_MS, poll);
        };
        this.ports.later(SOCKET_POLL_MS, poll);
        return;
      }
      case "close-pane-socket":
        if (this.paneSocket?.seq !== effect.seq) return;
        this.paneSocket.handle.close();
        this.paneSocket = null;
        return;
      case "pane-command": {
        if (this.paneSocket?.seq !== effect.seq) return;
        const { handle } = this.paneSocket;
        const { command } = effect;
        if (command.kind === "attach") handle.attach(command.paneId, command.cols, command.rows, command.keepSize);
        else if (command.kind === "detach") handle.detach(command.paneId);
        else if (command.kind === "resize") handle.resize(command.paneId, command.cols, command.rows, command.force);
        else if (command.kind === "keep-size") handle.keepSize(command.paneId);
        else handle.setMode(command.role);
        return;
      }
      case "upload-file":
        try { dispatch({ type: "upload-done", owner: effect.owner, id: effect.id, path: await this.ports.uploadFile(effect.machineId, effect.paneId, effect.file) }); }
        catch (error) { dispatch({ type: "upload-failed", owner: effect.owner, id: effect.id, message: message(error) }); }
        return;
      case "load-commands": {
        let commands: SlashCommand[] = [];
        try { commands = await this.ports.loadCommands(effect.machineId, effect.paneId); } catch { /* none offered */ }
        dispatch({ type: "commands-loaded", machineId: effect.machineId, paneId: effect.paneId, commands });
        return;
      }
      case "load-slash-usage":
        dispatch({ type: "slash-usage-loaded", usage: this.ports.loadSlashUsage() });
        return;
      case "save-slash-usage":
        this.ports.saveSlashUsage(effect.usage);
        return;
      case "search-files": {
        let files: string[] = [];
        try { files = await this.ports.searchFiles(effect.machineId, effect.paneId, effect.query); } catch { /* none listed */ }
        dispatch({ type: "files-found", seq: effect.seq, files });
        return;
      }
      case "submit": {
        // never queued: no socket now, and the box keeps its text
        const sent = this.paneSocket?.handle.submit(effect.paneId, effect.text, effect.payload, effect.typed) ?? null;
        if (sent === null) { dispatch({ type: "send-result", id: effect.id, outcome: { kind: "not-sent" } }); return; }
        dispatch({ type: "submit-started", id: effect.id });
        try {
          const result = await sent;
          dispatch({ type: "send-result", id: effect.id, outcome: result.ok ? { kind: "ok" } : { kind: "failed", code: result.code, message: result.message } });
        } catch { dispatch({ type: "send-result", id: effect.id, outcome: { kind: "unconfirmed" } }); }
        return;
      }
      case "answer-prompt":
        try {
          await this.ports.answerPrompt(effect.machineId, { pane_id: effect.paneId, prompt_id: effect.promptId, ...effect.answer });
          dispatch({ type: "answer-result", id: effect.id, outcome: { kind: "ok" } });
        } catch (error) {
          const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;
          const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null;
          dispatch({ type: "answer-result", id: effect.id, outcome: { kind: "failed", status, code, message: message(error) } });
        }
        return;
      case "composer-draft-change": {
        const { text, sending, settled } = this.ports.changeComposerDraft(effect.owner, effect.change);
        dispatch({ type: "composer-draft-loaded", owner: effect.owner, text, sending, settled });
        return;
      }
      case "line-draft-change": {
        const { text, sending } = this.ports.changeLineDraft(effect.owner, effect.change);
        dispatch({ type: "line-draft-loaded", owner: effect.owner, text, sending });
        return;
      }
      case "queue-change": {
        const { messages, unsaved } = this.ports.changeQueue(effect.owner, effect.change);
        dispatch({ type: "queue-loaded", owner: effect.owner, messages, unsaved });
        return;
      }
      case "read-conversation":
        dispatch({ type: "conversation-read", seq: effect.seq, olderSeq: effect.olderSeq, outcome: await this.ports.readConversation(effect.machineId, effect.paneId, { from: effect.from }) });
        return;
      case "fill-conversation-gap":
        dispatch({ type: "conversation-gap-filled", seq: effect.seq, olderSeq: effect.olderSeq, turns: await this.ports.conversationBetween(effect.machineId, effect.paneId, effect.held, effect.start) });
        return;
      case "read-conversation-scrollback":
        try {
          const { text, truncated } = await this.ports.readScrollback(effect.machineId, effect.paneId, effect.lines);
          dispatch({ type: "conversation-scrollback-read", seq: effect.seq, olderSeq: effect.olderSeq, outcome: { kind: "ok", text, truncated } });
        } catch (error) { dispatch({ type: "conversation-scrollback-read", seq: effect.seq, olderSeq: effect.olderSeq, outcome: { kind: "failed", message: message(error), status: null } }); }
        return;
      case "read-older-conversation":
        dispatch({ type: "older-conversation-read", olderSeq: effect.olderSeq, before: effect.before, outcome: await this.ports.readConversation(effect.machineId, effect.paneId, { before: effect.before }) });
        return;
      case "load-chat-prompt": {
        const { seq, sent } = effect;
        try {
          const { prompt, suggestion } = await this.ports.loadPromptState(effect.machineId, effect.paneId);
          dispatch({ type: "chat-prompt-read", seq, sent, prompt, suggestion });
        } catch { dispatch({ type: "chat-prompt-failed", seq }); }
        return;
      }
      case "load-draft":
        dispatch({ type: "draft-loaded", owner: effect.owner, value: this.ports.loadDraft(effect.owner) });
        return;
      case "save-draft":
        this.ports.saveDraft(effect.owner, effect.value);
        return;
      case "send-draft":
        // never queued: a draft the socket does not take stays for the person to send again
        if (this.paneSocket?.handle.sendInput(effect.paneId, effect.text)) dispatch({ type: "draft-sent", owner: effect.owner });
        return;
      case "later":
        this.ports.later(effect.ms, () => dispatch(effect.event));
        return;
    }
  }
}
