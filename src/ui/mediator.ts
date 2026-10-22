import type { AgentRun, FleetEntrance, FleetEntrances, FleetSettings, FleetSettingsPatch, LandingChecks, ModelListing, UsageEntry } from "../../shared/fleet.ts";
import type { Plan } from "../../shared/plan.ts";
import type { SideChatSnapshot } from "../../shared/side-chat.ts";
import type { Machine, MachineEvent } from "../../shared/machines.ts";
import type { BridgeHealth } from "../../shared/machines.ts";
import type { PairedDevice, PairingCode, RemoteAccess, SessionSnapshot } from "../../shared/protocol.ts";
import type { HealthInfo } from "../lib/api.ts";
import type { PaneView } from "../lib/actions.ts";
import type { NotificationState } from "../lib/notifications.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { AgentKind, ClientRole, SlashCommand, ConversationTurn, DirectoryListing, ExplainRequest, HerdrPane, InteractivePrompt, PromptAnswer, ServerMessage, WorkspaceCreated } from "../../shared/protocol.ts";
import type { SubmitResult } from "../lib/ws.ts";
import type { InputDraft } from "../lib/draft.ts";
import type { HeldMessage } from "../lib/messageQueue.ts";
import type { Settings } from "../lib/settings.ts";
import type { FilePreview } from "../lib/fileHistory.ts";
import { t } from "../lib/i18n.ts";
import { INITIAL_STATE, lensed, SIDE_LENSES, transition, type ComposerDraftChange, type ConversationOutcome, type Effect, type ExplainOutcome, type FileOutcome, type LineDraftChange, type QueueChange, type RequestAction, type SessionRequest, type TreeRequest, type Lens, type UiEvent, type UiState } from "./state.ts";

type PtyData = Extract<ServerMessage, { type: "pty-data" }>;

/** The terminal's socket (lib/ws.ts HerdrSocket), as the Mediator and the terminal use it. */
export interface PaneSocketHandle {
  readonly connected: boolean;
  /** the server stopped the output (4008) while the page was put away: it attaches again when back (ws.ts) */
  readonly stoppedWhileHidden: boolean;
  attach(paneId: string, cols: number, rows: number, keepSize?: boolean): void;
  detach(paneId: string): void;
  resize(paneId: string, cols: number, rows: number, force?: boolean): void;
  keepSize(paneId: string): void;
  setMode(mode: ClientRole): void;
  canInput(paneId: string): boolean;
  sendInput(paneId: string, text: string): boolean;
  /** settles once a liveness check in flight ends: true when this connection is still open */
  checked(): Promise<boolean>;
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
  /** the person pressed Reconnect in one terminal: one whose output stopped attaches again too */
  reconnect(): void;
}

/** What the terminal sends straight to its socket: keystrokes, and a secret. Nothing while no socket is open. */
export interface TerminalLink {
  connected(): boolean;
  /** the output stopped while the page was put away, not because this device is too slow (ws.ts) */
  stoppedWhileHidden(): boolean;
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
  /** `all`: every CLI now; otherwise only those last tried long ago */
  refreshUsage(all: boolean): Promise<UsageEntry[]>;
  runRequest(action: RequestAction): Promise<void>;
  loadLandingDiff(runId: string): Promise<{ diff: string; truncated: boolean }>;
  loadLandingChecks(runId: string): Promise<LandingChecks>;
  loadPlan(runId: string): Promise<Plan>;
  loadFleetSettings(cwd: string | null): Promise<FleetSettings>;
  saveFleetSettings(cwd: string | null, patch: FleetSettingsPatch): Promise<FleetSettings>;
  loadFleetEntrances(): Promise<FleetEntrances>;
  loadFleetModels(): Promise<ModelListing[]>;
  changeFleetEntrance(id: FleetEntrance["id"], action: "install" | "remove"): Promise<FleetEntrances>;
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
  /** asks Claude Haiku to explain a question a pane's agent asked; a refusal is an outcome, not a throw */
  explainQuestion(machineId: string, request: ExplainRequest): Promise<ExplainOutcome>;
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
  /** a terminal for a pane: a shell in its folder, in a tab of its workspace (the one there already unless `another`, else a new one); its pane id */
  openSideTerminal(machineId: string, paneId: string, another: boolean): Promise<string>;
  /** reads the side chat of a pane on this PC now and after each change, until the answer is called */
  watchSideChat(paneId: string, changed: (chat: SideChatSnapshot | null) => void): () => void;
  /** asks a pane's open side chat (`chatId`), or starts a new one with `text` first; the side chat as it is then */
  askSideChat(paneId: string, chatId: string | null, text: string): Promise<SideChatSnapshot>;
  interruptSideChat(chatId: string): Promise<void>;
  closeSideChat(chatId: string): Promise<void>;
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
  /** the side chat read for the side panel: stops reading it */
  private unwatchSideChat: (() => void) | null = null;
  /** the terminal's socket open now, by the opening it answers */
  private paneSocket: { seq: number; handle: PaneSocketHandle } | null = null;
  /** each lens's xterm: the pane's terminal, and the side panel's */
  private readonly terminals = new Map<Lens, TerminalSink>();

  constructor(private readonly ports: EffectPorts, initial: UiState = INITIAL_STATE) {
    this.state = initial;
  }

  getState = (): UiState => this.state;

  /** A lens's xterm takes the socket's messages until the function returned is called. */
  attachTerminal = (sink: TerminalSink, lens: Lens = "main"): (() => void) => {
    this.terminals.set(lens, sink);
    return () => { if (this.terminals.get(lens) === sink) this.terminals.delete(lens); };
  };

  /** Reconnect in one terminal: the connection is every terminal's, so each one stopped with it attaches again. */
  reconnectTerminals = (): void => {
    for (const sink of [...this.terminals.values()]) sink.reconnect();
  };

  /** The lens whose terminal shows a pane: a lens beside whose grid attached it, else the pane's own. */
  private lensOf(paneId: string | undefined): Lens {
    return SIDE_LENSES.find((lens) => paneId !== undefined && this.terminals.has(lens) && lensed(this.state, lens).pane.session.paneId === paneId) ?? "main";
  }

  readonly terminalLink: TerminalLink = {
    connected: () => this.paneSocket?.handle.connected ?? false,
    stoppedWhileHidden: () => this.paneSocket?.handle.stoppedWhileHidden ?? false,
    canInput: (paneId) => this.paneSocket?.handle.canInput(paneId) ?? false,
    sendInput: (paneId, text) => this.paneSocket?.handle.sendInput(paneId, text) ?? false,
    sendSecret: (paneId, prompt, secret) => this.paneSocket?.handle.sendSecret(paneId, prompt, secret) ?? null,
  };

  /**
   * A message from the terminal's socket: the output goes to the terminal alone; anything else to
   * the terminal too, and as events to the state for what it says of the attached pane.
   */
  /** Whether each lens's pane takes keys, told only on a change: asked on each message and each poll. */
  private readInputReady(handle: PaneSocketHandle): void {
    for (const lens of ["main", ...SIDE_LENSES] as const) {
      const { session } = lensed(this.state, lens).pane;
      if (session.paneId !== null && (lens === "main" || this.terminals.has(lens)) && session.inputReady !== handle.canInput(session.paneId)) {
        this.dispatch({ type: "pane-input-ready", paneId: session.paneId, ready: handle.canInput(session.paneId), ...(lens === "main" ? {} : { lens }) });
      }
    }
  }

  private paneMessage(seq: number, message: ServerMessage): void {
    if (this.paneSocket?.seq !== seq) return;
    const { handle } = this.paneSocket;
    const paneId = this.state.pane.session.paneId;
    const connection = (): void => this.dispatch({ type: "pane-connection", connected: handle.connected });
    this.readInputReady(handle);
    const about = "pane_id" in message ? message.pane_id : undefined;
    const lens = this.lensOf(about);
    // what the state is told of a pane goes to the lens that shows it
    const dispatch = (event: UiEvent): void => this.dispatch(lens === "main" ? event : { ...event, lens });
    if (message.type === "pty-data") {
      const acknowledge = handle.outputAcknowledgement(message);
      // nothing to write it to: the server must not wait on it
      const terminal = this.terminals.get(lens);
      if (terminal) terminal.output(message, acknowledge); else acknowledge?.();
      if (message.pane_id === paneId) connection();
      return;
    }
    // what is said of one pane goes to the grid that shows it; the rest (the role, a snapshot) to every grid
    if (about === undefined) for (const terminal of this.terminals.values()) terminal.message(message);
    else this.terminals.get(lens)?.message(message);
    const shown = lensed(this.state, lens).pane.session.paneId;
    switch (message.type) {
      case "attach-resumed":
        dispatch({ type: "pane-attach-resumed", paneId: message.pane_id });
        break;
      case "pty-exit":
        dispatch({ type: "pane-exited", paneId: message.pane_id });
        break;
      case "role-ack":
        this.dispatch({ type: "role-ack", role: message.mode });
        break;
      case "error": {
        const about = message.pane_id ?? shown;
        if (message.code === "input_not_ready" || message.code === "input_failed") {
          if (message.pane_id !== undefined) dispatch({ type: "pane-input-failed", paneId: message.pane_id, message: message.message });
          return;
        }
        if (message.code === "attach_held" || message.code === "terminal_unsupported") {
          // a pane this terminal already left: its wait is not this pane's
          if (about === null || about !== shown) return;
          dispatch({ type: message.code === "attach_held" ? "pane-attach-held" : "pane-terminal-unsupported", paneId: about });
          break;
        }
        if (message.code === "attach_failed") {
          if (about === null || about !== shown) return;
          // the server could not start herdr: nothing is coming, so the terminal says why instead of waiting
          dispatch({ type: "pane-output-failed", message: t("herdr could not be started on the server, so this terminal cannot attach. Put herdr on the server's PATH or set HERDR_FLEET_HERDR_BIN to its full path.") });
          return;
        }
        if (message.code === "output_stalled" || message.code === "attach_conflict") {
          if (message.code === "output_stalled") this.dispatch({ type: "output-stalled" });
          // the connection stays as the stop left it until the next read of it
          dispatch({ type: "pane-output-failed", message: message.message });
          // the socket's own stop is the whole connection's: the side panel's terminal says it too, with its Reconnect
          if (message.code === "output_stalled" && message.pane_id === undefined) {
            for (const lens of SIDE_LENSES) if (this.terminals.has(lens)) this.dispatch({ type: "pane-output-failed", message: message.message, lens });
          }
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
        try { dispatch({ type: "usage-refreshed", entries: await this.ports.refreshUsage(true) }); } catch (error) { dispatch({ type: "usage-refresh-failed", message: message(error) }); }
        return;
      case "auto-refresh-usage":
        // nobody asked: a failure shows in the capsules (the server records it), not as an error
        try { dispatch({ type: "usage-auto-refreshed", entries: await this.ports.refreshUsage(false) }); } catch { /* the next tick asks again */ }
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
      case "load-fleet-models":
        try { dispatch({ type: "fleet-models-loaded", listings: await this.ports.loadFleetModels() }); }
        catch (error) { dispatch({ type: "fleet-models-failed", message: message(error) }); }
        return;
      case "load-fleet-entrances":
        try { dispatch({ type: "fleet-entrances-loaded", entrances: await this.ports.loadFleetEntrances() }); }
        catch (error) { dispatch({ type: "fleet-entrances-failed", message: message(error) }); }
        return;
      case "change-fleet-entrance":
        try { dispatch({ type: "fleet-entrance-changed", entrances: await this.ports.changeFleetEntrance(effect.id, effect.action) }); }
        catch (error) { dispatch({ type: "fleet-entrance-failed", message: message(error) }); }
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
            for (const terminal of this.terminals.values()) terminal.disconnected();
            dispatch({ type: "pane-socket-lost" });
            for (const lens of SIDE_LENSES) if (this.terminals.has(lens)) this.dispatch({ type: "pane-socket-lost", lens });
            dispatch({ type: "pane-connection", connected: false });
          },
        });
        this.paneSocket = { seq, handle };
        const poll = (): void => {
          if (this.paneSocket?.seq !== seq) return;
          dispatch({ type: "pane-connection", connected: handle.connected });
          // a liveness check refuses keys with no message to say so: the poll reads it
          this.readInputReady(handle);
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
      case "explain-question": {
        let outcome: ExplainOutcome;
        try { outcome = await this.ports.explainQuestion(effect.machineId, { pane_id: effect.paneId, ...effect.request }); }
        catch (error) { outcome = { kind: "failed", message: message(error), limited: false }; }
        dispatch({ type: "explain-result", machineId: effect.machineId, paneId: effect.paneId, key: effect.key, outcome });
        return;
      }
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
      case "send-draft": {
        // never queued: a draft the socket does not take stays for the person to send again. One
        // refused while the connection is checked goes once the check ends, on the same connection.
        const handle = this.paneSocket?.handle;
        if (!handle) return;
        if (handle.sendInput(effect.paneId, effect.text) || (await handle.checked() && handle.sendInput(effect.paneId, effect.text))) dispatch({ type: "draft-sent", owner: effect.owner });
        return;
      }
      case "later":
        this.ports.later(effect.ms, () => dispatch(effect.event));
        return;
      case "open-side-terminal":
        try { dispatch({ type: "side-terminal-opened", key: effect.key, paneId: await this.ports.openSideTerminal(effect.machineId, effect.paneId, effect.another) }); }
        catch (error) { dispatch({ type: "side-terminal-failed", key: effect.key, message: message(error) }); }
        return;
      case "watch-side-chat": {
        this.unwatchSideChat?.();
        this.unwatchSideChat = null;
        const { paneId } = effect;
        if (paneId !== null) this.unwatchSideChat = this.ports.watchSideChat(paneId, (chat) => dispatch({ type: "side-chat-pushed", paneId, chat }));
        return;
      }
      case "ask-side-chat":
        try { dispatch({ type: "side-chat-asked", paneId: effect.paneId, chat: await this.ports.askSideChat(effect.paneId, effect.chatId, effect.text) }); }
        catch (error) { dispatch({ type: "side-chat-ask-failed", paneId: effect.paneId, text: effect.text, message: message(error) }); }
        return;
      // what came of these, the stream says
      case "interrupt-side-chat":
        await this.ports.interruptSideChat(effect.chatId).catch(() => {});
        return;
      case "close-side-chat":
        await this.ports.closeSideChat(effect.chatId).catch(() => {});
        return;
    }
  }
}
