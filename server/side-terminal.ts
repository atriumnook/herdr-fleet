import type { PaneInfo, SessionSnapshot } from "../shared/herdr-api.generated.ts";
import { TERMINAL_TAB, workspaceTerminal } from "../shared/side-terminal.ts";

export interface SideTerminalDeps {
  snapshot(): Promise<Pick<SessionSnapshot, "panes" | "tabs">>;
  /** a tab in the workspace, its shell started in `cwd`; its pane */
  createTab(workspaceId: string, cwd: string | undefined, label: string): Promise<PaneInfo | undefined>;
}

/** the opens under way, by workspace: two at once must not both find none and open two tabs */
const opening = new Map<string, Promise<string>>();

/**
 * The terminal of the workspace a pane is in, as the side panel shows it: the one there already,
 * else a new tab with a shell in the pane's folder (its own start folder, the worktree of a thread).
 */
export async function openSideTerminal(paneId: string, deps: SideTerminalDeps): Promise<string> {
  const snapshot = await deps.snapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new SideTerminalError("pane_not_found", `herdr knows no pane ${paneId}.`);
  const known = workspaceTerminal(snapshot, paneId);
  if (known) return known;
  const previous = opening.get(pane.workspace_id);
  if (previous) return previous;
  const opened = (async () => {
    const created = await deps.createTab(pane.workspace_id, pane.cwd ?? undefined, TERMINAL_TAB);
    if (!created?.pane_id) throw new SideTerminalError("terminal_failed", "herdr opened no pane for the terminal.");
    return created.pane_id;
  })();
  opening.set(pane.workspace_id, opened);
  try {
    return await opened;
  } finally {
    opening.delete(pane.workspace_id);
  }
}

export class SideTerminalError extends Error {
  constructor(readonly code: "pane_not_found" | "terminal_failed", message: string) {
    super(message);
  }
}
