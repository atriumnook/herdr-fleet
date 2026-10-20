import { LOCAL_MACHINE, paneStorageId } from "../../shared/machines.ts";
import type { AgentRun, FleetAgentKind } from "../../shared/fleet.ts";
import { workspaceTerminal } from "../../shared/side-terminal.ts";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import { fleetFrontPane } from "./fleetView.ts";
import type { SidePanelTab, UiState } from "./state.ts";

export const SIDE_PANEL_REGIONS = ["screen", "selection", "machines", "runs", "fleetView", "sidePanel"] as const;
export type SidePanelSource = Pick<UiState, (typeof SIDE_PANEL_REGIONS)[number]>;

/** A side chat or a terminal as the panel shows it: none yet, on its way, failed, or open on its pane. */
export type SideSlot<T> = { kind: "none" } | { kind: "opening" } | { kind: "failed"; message: string } | ({ kind: "open"; paneId: string } & T);

export interface SidePanelModel {
  open: boolean;
  tab: SidePanelTab;
  /** the pane the panel is about: the one shown in front; null when none is */
  about: { machineId: string; paneId: string; title: string; cwd: string | null } | null;
  chat: SideSlot<{ runId: string; agent: FleetAgentKind }>;
  /** `in-pane`: the terminal is the pane the Pane screen shows, whose grid has it attached */
  terminal: SideSlot<object> | { kind: "in-pane" };
}

/** The pane in front: the Pane screen's, or the Fleet screen's thread, agent or coordinator (on this PC). */
function frontPane(state: SidePanelSource): { machineId: string; paneId: string } | null {
  if (state.screen === "fleet") {
    const paneId = fleetFrontPane(state);
    return paneId === null ? null : { machineId: LOCAL_MACHINE, paneId };
  }
  const { machineId, paneId } = state.selection;
  return paneId === null ? null : { machineId, paneId };
}

/** The live side chat about a pane, the newest: one that stopped or failed has no pane left to show (as the server counts them). */
function sideChatOf(runs: AgentRun[], paneId: string): AgentRun | undefined {
  return runs.filter((run) => run.sideChatOf === paneId && run.state !== "stopped" && run.state !== "failed").sort((a, b) => b.startedAt - a.startedAt)[0];
}

export function sidePanelModel(state: SidePanelSource): SidePanelModel {
  const { open, tab } = state.sidePanel;
  const front = frontPane(state);
  const snapshot = front ? state.machines.list.find((machine) => machine.id === front.machineId)?.snapshot ?? null : null;
  const pane = front ? snapshot?.panes.find((candidate) => candidate.pane_id === front.paneId) : undefined;
  if (!front || !snapshot || !pane) return { open, tab, about: null, chat: { kind: "none" }, terminal: { kind: "none" } };
  const key = paneStorageId(front.machineId, front.paneId);
  const about = { machineId: front.machineId, paneId: front.paneId, title: displayPaneTitle(pane), cwd: pane.cwd ?? null };

  let chat: SidePanelModel["chat"];
  const run = sideChatOf(state.runs.data, front.paneId);
  const asked = state.sidePanel.chats[key];
  if (run) chat = { kind: "open", paneId: run.paneId, runId: run.id, agent: run.agent };
  // started: open once the runs read again list it
  else if (asked?.status === "opening" || asked?.status === "opened") chat = { kind: "opening" };
  else if (asked?.status === "failed") chat = { kind: "failed", message: asked.message };
  else chat = { kind: "none" };

  let terminal: SidePanelModel["terminal"];
  const found = workspaceTerminal(snapshot, front.paneId);
  const opening = state.sidePanel.terminals[key];
  // one pane has one grid here: a second attach of it would end with the first one's detach
  const inPane = (paneId: string) => state.selection.machineId === front.machineId && state.selection.paneId === paneId;
  if (found !== null && inPane(found)) terminal = { kind: "in-pane" };
  else if (found !== null) terminal = { kind: "open", paneId: found };
  else if (opening?.status === "opened" && snapshot.panes.some((candidate) => candidate.pane_id === opening.paneId)) terminal = { kind: "open", paneId: opening.paneId };
  // opened: shown once the session tree has it
  else if (opening?.status === "opening" || opening?.status === "opened") terminal = { kind: "opening" };
  else if (opening?.status === "failed") terminal = { kind: "failed", message: opening.message };
  else terminal = { kind: "none" };

  return { open, tab, about, chat, terminal };
}
