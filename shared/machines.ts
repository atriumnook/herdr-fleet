import type { HealthAuth, ServerMessage, SessionSnapshot } from "./protocol.ts";

export const LOCAL_MACHINE = "local";
export const BRIDGE_PROTOCOL = 1;
export interface PaneTarget { machine_id: string; pane_id: string }
export type MachineState = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
export interface Machine {
  id: string;
  name: string;
  kind: "local";
  enabled: boolean;
  state: MachineState;
  error: string | null;
  snapshot: SessionSnapshot | null;
  herdr?: HerdrIdentity;
}
/**
 * The herdr behind a PC, as its bridge can serve it. terminal_attach is false on a Windows
 * host: herdr has no `terminal attach` there yet (herdrdev/herdr#4821), and it is false on
 * any bridge whose runtime cannot run the PTY sidecar (the win32 bundle ships none). Such a
 * PC's panes have the chat lens and a mirrored terminal (terminal_mirror). Absent on older
 * bridges, which are never Windows.
 */
export interface HerdrIdentity {
  version: string;
  protocol: number;
  terminal_attach?: boolean;
  /** without attach, the terminal lens shows the pane's screen repainted a few times a second (server/mirror.ts) */
  terminal_mirror?: boolean;
}
export type MachineEvent = { type: "machines"; machines: Machine[] } | { type: "machine-message"; machine_id: string; message: ServerMessage };
export interface BridgeHealth { ok: true; auth: HealthAuth; bridge_protocol: number }

/** Local storage keeps its historical keys; remote IDs occupy a separate namespace. */
export function paneStorageId(machineId: string, paneId: string): string {
  return machineId === LOCAL_MACHINE ? paneId : `remote:${encodeURIComponent(machineId)}:${encodeURIComponent(paneId)}`;
}
export function machinePath(machineId: string, path: string): string {
  return machineId === LOCAL_MACHINE ? `/api/${path}` : `/api/machines/${encodeURIComponent(machineId)}/${path}`;
}
