import { LOCAL_MACHINE, paneStorageId } from "../../shared/machines.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import type { SideChatSnapshot } from "../../shared/side-chat.ts";
import { workspaceTerminals } from "../../shared/side-terminal.ts";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import { fleetFrontPane } from "./fleetView.ts";
import type { SidePanelTab, UiState } from "./state.ts";

export const SIDE_PANEL_REGIONS = ["screen", "selection", "machines", "runs", "fleetView", "sidePanel"] as const;
export type SidePanelSource = Pick<UiState, (typeof SIDE_PANEL_REGIONS)[number]>;

/** The terminals of the workspace of the pane the panel is about, and the one shown. */
export interface SideTerminals {
  /** each terminal's pane, in herdr's order */
  list: string[];
  /** the one shown; null with none */
  shown: string | null;
  /** the one shown is the pane the Pane screen shows, whose grid has it attached */
  inPane: boolean;
  /** one asked for is on its way */
  opening: boolean;
  failed: string | null;
}

export interface SidePanelModel {
  open: boolean;
  tab: SidePanelTab;
  /** a shortcut asked for the tab's input: it takes the keyboard once per seq */
  focusSeq: number;
  /** the pane the panel is about: the one shown in front; null when none is. `key`: its storage id */
  about: { machineId: string; paneId: string; title: string; cwd: string | null; key: string } | null;
  /** a side chat runs on this PC's server: a pane on another PC has none */
  chatHere: boolean;
  terminals: SideTerminals;
}

const NO_TERMINALS: SideTerminals = { list: [], shown: null, inPane: false, opening: false, failed: null };

/** The pane in front: the Pane screen's, or the Fleet screen's thread, agent or coordinator (on this PC). */
function frontPane(state: SidePanelSource): { machineId: string; paneId: string } | null {
  if (state.screen === "fleet") {
    const paneId = fleetFrontPane(state);
    return paneId === null ? null : { machineId: LOCAL_MACHINE, paneId };
  }
  const { machineId, paneId } = state.selection;
  return paneId === null ? null : { machineId, paneId };
}

export function sidePanelModel(state: SidePanelSource): SidePanelModel {
  const { open, tab, focusSeq } = state.sidePanel;
  const front = frontPane(state);
  const snapshot = front ? state.machines.list.find((machine) => machine.id === front.machineId)?.snapshot ?? null : null;
  const pane = front ? snapshot?.panes.find((candidate) => candidate.pane_id === front.paneId) : undefined;
  if (!front || !snapshot || !pane) return { open, tab, focusSeq, about: null, chatHere: false, terminals: NO_TERMINALS };
  const key = paneStorageId(front.machineId, front.paneId);
  const about = { machineId: front.machineId, paneId: front.paneId, title: displayPaneTitle(pane), cwd: pane.cwd ?? null, key };

  const list = workspaceTerminals(snapshot, front.paneId);
  const asked = state.sidePanel.terminals[key];
  // opened: shown once the session tree has it
  const opening = asked?.status === "opening" || (asked?.status === "opened" && !list.includes(asked.paneId));
  const picked = state.sidePanel.shownTerminal[key];
  const shown = picked !== undefined && list.includes(picked) ? picked : list[0] ?? null;
  // one pane has one grid here: a second attach of it would end with the first one's detach
  const inPane = shown !== null && state.selection.machineId === front.machineId && state.selection.paneId === shown;
  const terminals = { list, shown, inPane, opening, failed: asked?.status === "failed" ? asked.message : null };

  return { open, tab, focusSeq, about, chatHere: front.machineId === LOCAL_MACHINE, terminals };
}

/** A side chat's turns as the chat draws them: the reply's text as it comes goes after the last whole message. */
export function sideChatTurns(chat: SideChatSnapshot): ConversationTurn[] {
  if (!chat.streaming) return chat.turns;
  const last = chat.turns[chat.turns.length - 1];
  const part = { kind: "text" as const, text: chat.streaming };
  if (last?.role === "assistant") return [...chat.turns.slice(0, -1), { ...last, parts: [...last.parts, part] }];
  return [...chat.turns, { role: "assistant", ts: null, parts: [part] }];
}
