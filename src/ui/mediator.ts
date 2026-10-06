import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import type { Machine, MachineEvent } from "../../shared/machines.ts";
import type { BridgeHealth } from "../../shared/machines.ts";
import type { PairedDevice, PairingCode, RemoteAccess, SessionSnapshot } from "../../shared/protocol.ts";
import type { HealthInfo } from "../lib/api.ts";
import type { PaneView } from "../lib/actions.ts";
import type { NotificationState } from "../lib/notifications.ts";
import type { DropletKind } from "../lib/droplet.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { AgentKind, HerdrPane, WorkspaceCreated } from "../../shared/protocol.ts";
import type { Settings } from "../lib/settings.ts";
import { INITIAL_STATE, transition, type Effect, type RequestAction, type SessionRequest, type TreeRequest, type UiEvent, type UiState } from "./state.ts";

/** What the Mediator's effects reach: the server's API and this browser's storage, or a test's stand-in. */
export interface EffectPorts {
  loadRuns(): Promise<AgentRun[]>;
  loadUsage(): Promise<UsageEntry[]>;
  refreshUsage(): Promise<UsageEntry[]>;
  runRequest(action: RequestAction): Promise<void>;
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
  dropIn(alert: { machineId: string; machineName: string | null; pane: HerdrPane; alert: DropletKind }): void;
  /** the tab's own alert; `open` selects the pane when it is tapped */
  notifyPane(alert: { machineId: string; machineName: string; pane: HerdrPane; status: "blocked" | "done" | "ended" }, open: () => void): void;
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

  constructor(private readonly ports: EffectPorts, initial: UiState = INITIAL_STATE) {
    this.state = initial;
  }

  getState = (): UiState => this.state;

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
    for (const effect of effects) void this.run(effect);
  };

  private async run(effect: Effect): Promise<void> {
    switch (effect.kind) {
      case "load-runs":
        try { this.dispatch({ type: "runs-loaded", runs: await this.ports.loadRuns() }); } catch (error) { this.dispatch({ type: "runs-failed", message: message(error) }); }
        return;
      case "load-usage":
        try { this.dispatch({ type: "usage-loaded", entries: await this.ports.loadUsage() }); } catch (error) { this.dispatch({ type: "usage-failed", message: message(error) }); }
        return;
      case "refresh-usage":
        try { this.dispatch({ type: "usage-refreshed", entries: await this.ports.refreshUsage() }); } catch (error) { this.dispatch({ type: "usage-refresh-failed", message: message(error) }); }
        return;
      case "request":
        try { await this.ports.runRequest(effect.action); this.dispatch({ type: "request-done" }); } catch (error) { this.dispatch({ type: "request-failed", message: message(error) }); }
        return;
      case "save-settings":
        this.ports.saveSettings(effect.settings);
        return;
      case "forget-pane-views":
        this.ports.forgetPaneViews();
        return;
      case "load-remote-access":
        try { this.dispatch({ type: "remote-access-loaded", access: await this.ports.loadRemoteAccess() }); } catch (error) { this.dispatch({ type: "remote-access-failed", message: message(error) }); }
        return;
      case "load-devices":
        try {
          const devices = await this.ports.loadDevices();
          this.dispatch(devices === null ? { type: "devices-failed", message: "", unavailable: true, session: effect.session } : { type: "devices-loaded", devices, session: effect.session });
        } catch (error) { this.dispatch({ type: "devices-failed", message: message(error), unavailable: false, session: effect.session }); }
        return;
      case "start-pairing":
        try { this.dispatch({ type: "pairing-started", code: await this.ports.startPairing(), at: Date.now(), session: effect.session }); } catch (error) { this.dispatch({ type: "device-change-failed", message: message(error), session: effect.session }); }
        return;
      case "rename-device":
        try { await this.ports.renameDevice(effect.id, effect.label); this.dispatch({ type: "device-renamed", session: effect.session }); } catch (error) { this.dispatch({ type: "device-change-failed", message: message(error), session: effect.session }); }
        return;
      case "revoke-device":
        try { await this.ports.revokeDevice(effect.id); this.dispatch({ type: "device-changed", session: effect.session }); } catch (error) { this.dispatch({ type: "device-change-failed", message: message(error), session: effect.session }); }
        return;
      case "test-push":
        try { this.dispatch({ type: "push-tested", result: await this.ports.testPush(), session: effect.session }); } catch { this.dispatch({ type: "push-tested", result: "failed", session: effect.session }); }
        return;
      case "tree-request": {
        const { machineId, request, viaConfirm, revert } = effect;
        try { await this.ports.treeRequest(machineId, request); this.dispatch({ type: "tree-done", machineId, viaConfirm }); }
        catch (error) { this.dispatch({ type: "tree-failed", machineId, request, reason: message(error), viaConfirm, revert }); }
        return;
      }
      case "load-health":
        try { this.dispatch({ type: "access-loaded", auth: (await this.ports.loadAccess()).auth }); } catch { /* the gate stays while the server restarts */ }
        try { this.dispatch({ type: "health-loaded", health: await this.ports.loadHealth() }); } catch { this.dispatch({ type: "health-failed" }); }
        return;
      case "load-machines":
        try {
          const machines = await this.ports.loadMachines();
          this.dispatch(machines === "unauthorized" ? { type: "machines-failed", message: "", unauthorized: true, revision: effect.revision } : { type: "machines-loaded", machines, revision: effect.revision });
        } catch (error) { this.dispatch({ type: "machines-failed", message: message(error), unauthorized: false, revision: effect.revision }); }
        return;
      case "authenticate":
        try { await this.ports.authenticate(effect.token); this.dispatch({ type: "authenticated", reason: effect.reason }); } catch { this.dispatch({ type: "authentication-failed", reason: effect.reason }); }
        return;
      case "pair-from-address":
        // the gate, if any, reports a code that failed
        try { await this.ports.pairFromAddress(effect.code); this.dispatch({ type: "paired-from-address" }); } catch { /* as above */ }
        return;
      case "sign-out":
        try { await this.ports.signOut(); } catch { /* the cookie may still be set: health decides */ }
        this.dispatch({ type: "signed-out" });
        return;
      case "open-stream":
        this.closeStream?.();
        this.closeStream = this.ports.openStream({
          opened: () => this.dispatch({ type: "stream-opened" }),
          event: (event) => this.dispatch(event.type === "machines" ? { type: "machines-pushed", machines: event.machines } : { type: "machine-message", machineId: event.machine_id, message: event.message, at: Date.now() }),
        });
        return;
      case "close-stream":
        this.closeStream?.();
        this.closeStream = null;
        return;
      case "confirm-pane-gone":
        try { this.dispatch({ type: "pane-session-read", machineId: effect.machineId, paneId: effect.paneId, session: await this.ports.loadSession(effect.machineId) }); }
        catch { this.dispatch({ type: "pane-session-failed", machineId: effect.machineId, paneId: effect.paneId }); }
        return;
      case "enable-alerts": {
        // an older browser can throw instead of answering: that is no permission
        const permission = await this.ports.requestPermission().catch((): NotificationState => "default");
        this.dispatch({ type: "alerts-permission", permission });
        let ok = false;
        if (permission === "granted") {
          try {
            const endpoint = await this.ports.subscribePush(effect.prefs);
            this.dispatch({ type: "push-subscribed", on: endpoint !== null, seq: null });
            if (endpoint !== null) await this.ports.confirmPush(endpoint);
            ok = endpoint !== null;
          } catch (error) {
            console.warn("web push unavailable, alerts stay tab-only", error);
          }
        }
        this.dispatch({ type: "alerts-enabled", ok, session: effect.session });
        return;
      }
      case "remove-push":
        await this.ports.removePush().catch((error: unknown) => console.warn("could not drop the push subscription", error));
        return;
      case "subscribe-push":
        try { this.dispatch({ type: "push-subscribed", on: (await this.ports.subscribePush(effect.prefs)) !== null, seq: effect.seq }); }
        catch { this.dispatch({ type: "push-subscribed", on: false, seq: effect.seq }); }
        return;
      case "drop-in":
        this.ports.dropIn(effect);
        return;
      case "notify-pane":
        this.ports.notifyPane(effect, () => this.dispatch({ type: "select-pane", machineId: effect.machineId, paneId: effect.pane.pane_id }));
        return;
      case "load-agents":
        try { this.dispatch({ type: "new-session-agents", agents: await this.ports.loadAgentKinds(effect.machineId), remembered: this.ports.rememberedAgent(), seq: effect.seq }); }
        catch (error) { this.dispatch({ type: "new-session-agents-failed", message: message(error), seq: effect.seq }); }
        return;
      case "load-recent":
        this.dispatch({ type: "palette-recent", machineId: effect.machineId, recent: this.ports.loadRecent(effect.machineId) });
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
          if (created === "invalid-cwd") { this.dispatch({ type: "new-session-failed", message: "", invalidCwd: true, seq: effect.seq }); return; }
          const agentError = effect.request.agent !== null && !created.agent_started ? created.error?.message ?? null : null;
          this.dispatch({ type: "new-session-created", paneId: created.pane_id, agentError, seq: effect.seq });
        } catch (error) { this.dispatch({ type: "new-session-failed", message: message(error), invalidCwd: false, seq: effect.seq }); }
        return;
      case "store-lens":
        this.ports.storeLens(effect.storageId, effect.view);
        return;
      case "store-selection":
        this.ports.storeSelection(effect.machineId, effect.paneId);
        return;
      case "later":
        this.ports.later(effect.ms, () => this.dispatch(effect.event));
        return;
    }
  }
}
