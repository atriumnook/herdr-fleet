import { hostname } from "node:os";
import { LOCAL_MACHINE, type Machine, type MachineEvent } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot, HerdrPane } from "../shared/protocol.ts";
import { sessionSnapshot } from "./herdr/client.ts";
import type { CompletionTracker } from "./completion.ts";

/**
 * The PC list the app shows: this PC only. Its roster is read from herdr every few seconds
 * and again on any structure change, and pushed to every subscriber (/api/machines/events).
 */
export class MachineManager {
  private listeners = new Set<(event: MachineEvent) => void>();
  private stopped = false;
  private localBusy = false;
  private localRefreshQueued = false;
  private localRevision = 0;
  private localTimer: ReturnType<typeof setInterval>;
  private local: Machine = { id: LOCAL_MACHINE, name: hostname(), kind: "local", enabled: true, state: "connecting", error: null, snapshot: null };

  constructor(private completions: CompletionTracker, private readLocal: () => Promise<SessionSnapshot> = () => this.completions.readSnapshot(sessionSnapshot)) {
    void this.refreshLocal();
    this.localTimer = setInterval(() => void this.refreshLocal(), 5000);
    this.localTimer.unref();
  }
  list(): Machine[] { return [this.local]; }
  subscribe(listener: (event: MachineEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "machines", machines: this.list() });
    return () => this.listeners.delete(listener);
  }
  private emit(event?: MachineEvent): void {
    if (this.stopped) return;
    for (const listener of this.listeners) listener(event ?? { type: "machines", machines: this.list() });
  }
  localMessage(message: ServerMessage): void {
    if (["pane-status", "session-changed", "pane-exited"].includes(message.type)) {
      this.localRevision++;
      if (this.localBusy) this.localRefreshQueued = true;
    }
    this.emit({ type: "machine-message", machine_id: LOCAL_MACHINE, message });
    if (message.type === "pane-status" && this.local.snapshot) {
      this.local.snapshot = { ...this.local.snapshot, panes: this.local.snapshot.panes.map((p: HerdrPane) => p.pane_id === message.pane_id ? { ...p, agent_status: message.agent_status } : p) };
    }
    if (message.type === "session-changed" || message.type === "pane-exited") void this.refreshLocal();
  }
  async refreshLocal(): Promise<void> {
    if (this.stopped) return;
    if (this.localBusy) { this.localRefreshQueued = true; return; }
    this.localBusy = true;
    try {
      do {
        this.localRefreshQueued = false;
        const revision = this.localRevision;
        try {
          const snapshot = await this.readLocal();
          if (this.stopped) break;
          // A newer event already patched the roster. Never publish this older load.
          if (revision !== this.localRevision) { this.localRefreshQueued = true; continue; }
          this.local.snapshot = snapshot; this.local.state = "connected"; this.local.error = null;
        } catch (e) {
          if (this.stopped) break;
          if (revision !== this.localRevision) { this.localRefreshQueued = true; continue; }
          this.local.state = "error"; this.local.error = String(e instanceof Error ? e.message : e);
        }
        this.emit();
      } while (this.localRefreshQueued && !this.stopped);
    } finally { this.localBusy = false; }
  }
  stop(): void {
    this.stopped = true; clearInterval(this.localTimer);
    this.listeners.clear();
  }
}
