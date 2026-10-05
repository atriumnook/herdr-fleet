/** Which pane this window shows across reloads, and the one a notification's address names. */

const SELECTION_KEY = "herdr-fleet:selection";
type StoredSelection = { machine_id?: string; pane_id?: string | null };

export function paneFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("pane");
}

/**
 * The pane to open: this window's own (sessionStorage is per window and survives
 * its reloads), else the last one any window showed, for a newly opened window.
 */
function storedSelection(): StoredSelection | null {
  for (const storage of ["sessionStorage", "localStorage"] as const) {
    try {
      const value: unknown = JSON.parse(window[storage].getItem(SELECTION_KEY) ?? "null");
      if (value !== null && typeof value === "object") return value as StoredSelection;
    } catch {
      /* private mode */
    }
  }
  return null;
}

export function storeSelection(machineId: string, paneId: string | null): void {
  for (const storage of ["sessionStorage", "localStorage"] as const) {
    try { window[storage].setItem(SELECTION_KEY, JSON.stringify({ machine_id: machineId, pane_id: paneId })); } catch {}
  }
}

/** The pane a page load opens: the one its address names (a tapped notification), else the one kept. */
export function initialSelection(): { machineId: string; paneId: string | null } {
  const query = new URLSearchParams(window.location.search);
  if (query.has("pane")) return { machineId: query.get("machine") ?? "local", paneId: paneFromUrl() || (storedSelection()?.pane_id ?? null) };
  const stored = storedSelection();
  return { machineId: stored?.machine_id ?? "local", paneId: stored?.pane_id ?? null };
}
