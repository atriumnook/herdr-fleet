import { useEffect, useRef } from "react";
import { DirectoryBrowser, type DirectoryBrowserEvent } from "../components/DirectoryBrowser.tsx";
import { useMachineId } from "../lib/machineContext.tsx";
import type { Emit } from "./bubble.ts";
import type { FolderSlot, UiEvent } from "./state.ts";
import { useSelected } from "./presenter.ts";

export type FolderBrowserUpEvent = Extract<UiEvent, { type: "open-folders" | "close-folders" | "browse-folder" | "show-hidden-folders" }>;

export interface DirectoryBrowserPresenterProps {
  /** where it shows: one browser at a time there */
  slot: FolderSlot;
  /** where to open: the path typed so far (absolute, `~` or `~/…`); empty or unreadable opens home */
  start: string;
  /** the folder chosen, in the dialog's own syntax; without it there is no "Use this folder" */
  onPick?: (path: string) => void;
  /** lists files too, and opens the one clicked (its absolute path) */
  onOpenFile?: (path: string) => void;
  emit: Emit<FolderBrowserUpEvent>;
}

/**
 * A folder browser's Presenter: its slot's region, read from the PC the surrounding context
 * names. It opens with the browser and is forgotten when the browser goes; a folder chosen or
 * a file opened is the parent's.
 */
export function DirectoryBrowserPresenter({ slot, start, onPick, onOpenFile, emit }: DirectoryBrowserPresenterProps) {
  const machineId = useMachineId();
  const browser = useSelected((state) => state.folders.open[slot]);
  const files = onOpenFile !== undefined;
  const opening = useRef({ machineId, start, files, emit });
  opening.current = { machineId, start, files, emit };
  // what it opens at is the start it mounted with: a change of the typed path while it is open does not move it
  useEffect(() => {
    const { machineId: at, start: from, files: withFiles, emit: up } = opening.current;
    up({ type: "open-folders", slot, machineId: at, start: from, files: withFiles });
    return () => opening.current.emit({ type: "close-folders", slot });
  }, [slot]);
  const up = (event: DirectoryBrowserEvent): void => {
    if (event.type === "pick-folder") onPick?.(event.path);
    else if (event.type === "open-folder-file") onOpenFile?.(event.path);
    else emit({ ...event, slot });
  };
  return <DirectoryBrowser model={{
    start, listing: browser?.listing ?? null, hidden: browser?.hidden ?? false, loading: browser?.loading ?? true,
    error: browser?.error ?? null, files, canPick: onPick !== undefined,
  }} emit={up} />;
}
