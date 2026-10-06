/** The panes opened last on each PC, newest first: the command palette offers them first. */

const RECENT_KEY = "herdr-fleet:recent-panes";
export const RECENT_LIMIT = 8;

const keyFor = (machineId: string): string => (machineId === "local" ? RECENT_KEY : `${RECENT_KEY}:${machineId}`);

export function loadRecentPanes(machineId: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(keyFor(machineId)) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Puts a pane first among the ones opened last on its PC, as kept on this device. */
export function rememberPane(machineId: string, paneId: string): void {
  const recent = [paneId, ...loadRecentPanes(machineId).filter((id) => id !== paneId)].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(keyFor(machineId), JSON.stringify(recent));
  } catch {
    /* private mode: the order is not kept */
  }
}
