import type { PaneInfo, SessionSnapshot } from "../shared/herdr-api.generated.ts";
import { TERMINAL_TAB, workspaceTerminal } from "../shared/side-terminal.ts";

export interface SideTerminalDeps {
  snapshot(): Promise<Pick<SessionSnapshot, "panes" | "tabs">>;
  /** a tab in the workspace, its shell started in `cwd`; its pane */
  createTab(workspaceId: string, cwd: string | undefined, label: string): Promise<PaneInfo | undefined>;
}

/** the last open asked: each waits for the one before, so it reads a session tree with that one's tab in it */
let previous: Promise<unknown> = Promise.resolve();

/**
 * The terminal of the workspace a pane is in, as the side panel shows it: the one there already,
 * else a new tab with a shell in the pane's folder (its own start folder, the worktree of a thread).
 * Opens run one at a time, so two at once (a double click, two windows) open one tab.
 */
export function openSideTerminal(paneId: string, deps: SideTerminalDeps): Promise<string> {
  const opened = previous.catch(() => {}).then(() => openOne(paneId, deps));
  previous = opened;
  return opened;
}

async function openOne(paneId: string, deps: SideTerminalDeps): Promise<string> {
  const snapshot = await deps.snapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new SideTerminalError("pane_not_found", `herdr knows no pane ${paneId}.`);
  const known = workspaceTerminal(snapshot, paneId);
  if (known) return known;
  const created = await deps.createTab(pane.workspace_id, pane.cwd ?? undefined, TERMINAL_TAB);
  if (!created?.pane_id) throw new SideTerminalError("terminal_failed", "herdr opened no pane for the terminal.");
  return created.pane_id;
}

export class SideTerminalError extends Error {
  constructor(readonly code: "pane_not_found" | "terminal_failed", message: string) {
    super(message);
  }
}
