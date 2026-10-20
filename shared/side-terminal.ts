import type { SessionSnapshot } from "./herdr-api.generated.ts";

/** The label of the tab the side panel opens a workspace's terminal in, and finds it again by. */
export const TERMINAL_TAB = "terminal";

/**
 * The terminal of the workspace a pane is in: a shell (no agent) in a tab labelled `terminal`.
 * Never the pane itself: a pane opened as the terminal has no terminal beside it.
 */
export function workspaceTerminal(snapshot: Pick<SessionSnapshot, "panes" | "tabs">, paneId: string): string | null {
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) return null;
  const tabs = new Set(snapshot.tabs.filter((tab) => tab.workspace_id === pane.workspace_id && tab.label === TERMINAL_TAB).map((tab) => tab.tab_id));
  return snapshot.panes.find((candidate) => tabs.has(candidate.tab_id) && !candidate.agent && candidate.pane_id !== paneId)?.pane_id ?? null;
}
