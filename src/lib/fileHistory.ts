/** A file open in the viewer, as its history entry keeps it: with the PC and pane its path is read from. */
export interface FilePreview {
  path: string;
  paneId: string | null;
  machineId: string;
}
const HISTORY_KEY = "herdr-fleet:file-preview";

export function previewFromState(state: unknown): FilePreview | null {
  if (state === null || typeof state !== "object") return null;
  const preview = (state as Record<string, unknown>)[HISTORY_KEY];
  if (preview === null || typeof preview !== "object") return null;
  const value = preview as Record<string, unknown>;
  return typeof value.path === "string" && typeof value.machineId === "string" &&
    (value.paneId === null || typeof value.paneId === "string") ? { path: value.path, machineId: value.machineId, paneId: value.paneId } : null;
}

/**
 * Android Back traverses history: a preview must be an entry above the chat, not just a modal.
 * `replace`: a file chosen inside an open preview takes its entry, adding no Back step.
 */
export function showPreview(preview: FilePreview, replace: boolean): void {
  const state = { ...window.history.state, [HISTORY_KEY]: preview };
  if (replace) window.history.replaceState(state, "");
  else window.history.pushState(state, "");
}

/** X, Escape and scrim clicks consume the same entry as the system Back button; false when this entry is not a preview's. */
export function leavePreview(): boolean {
  if (previewFromState(window.history.state) === null) return false;
  window.history.back();
  return true;
}
