import type { AgentRun, UsageEntry } from "../../shared/fleet.ts";
import type { PairedDevice, PairingCode, RemoteAccess } from "../../shared/protocol.ts";
import type { Settings } from "../lib/settings.ts";
import { INITIAL_STATE, transition, type Effect, type RequestAction, type TreeRequest, type UiEvent, type UiState } from "./state.ts";

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
      case "store-selection":
        this.ports.storeSelection(effect.machineId, effect.paneId);
        return;
      case "later":
        this.ports.later(effect.ms, () => this.dispatch(effect.event));
        return;
    }
  }
}
