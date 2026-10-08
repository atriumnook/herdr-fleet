import { useEffect, useRef } from "react";
import { ArrowUp, FileText, Folder, House } from "lucide-react";

import "./DirectoryBrowser.css";

import type { DirectoryListing } from "../../shared/protocol.ts";
import { formatBytes } from "../lib/formatBytes.ts";
import { useT } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { FolderFailure } from "../ui/state.ts";

export interface DirectoryBrowserModel {
  /** where it opened: the path typed so far, shown until the first listing */
  start: string;
  listing: DirectoryListing | null;
  hidden: boolean;
  loading: boolean;
  error: FolderFailure | null;
  /** lists files too, and opens the one clicked */
  files: boolean;
  /** offers "Use this folder" */
  canPick: boolean;
}

export type DirectoryBrowserEvent =
  /** into a folder, up to its parent, or home ("") */
  | { type: "browse-folder"; path: string }
  | { type: "show-hidden-folders"; hidden: boolean }
  /** the folder chosen, in the dialog's own syntax (`~/…` inside home) */
  | { type: "pick-folder"; path: string }
  /** a file clicked, its absolute path */
  | { type: "open-folder-file"; path: string };

/** `~/…` for a path inside home, as the directory field is usually typed. */
export function homeRelative(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function childPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/**
 * A folder browser (the new session dialog, Files, a folder in the file viewer): one directory at
 * a time, read from the PC by the state machine. Nothing is kept but the folder shown now.
 */
export function DirectoryBrowser({ model, emit }: { model: DirectoryBrowserModel; emit: Emit<DirectoryBrowserEvent> }) {
  const t = useT();
  const { start, listing, hidden, loading, error, files, canPick } = model;
  const listRef = useRef<HTMLUListElement>(null);
  // each folder listed starts at its top
  useEffect(() => { listRef.current?.scrollTo?.({ top: 0 }); }, [listing]);
  const open = (path: string): void => emit({ type: "browse-folder", path });

  const path = listing?.path ?? "";
  const shown = listing ? homeRelative(listing.path, listing.home) : start || "~";
  const failure = error === "unsupported" ? t("This PC's bridge cannot browse folders yet. Type the path instead.")
    : error === "invalid" ? t("This folder cannot be opened.") : t("Folders could not be loaded.");

  return (
    <div className="dir-browser" role="group" aria-label={t("Choose a folder")} aria-busy={loading}>
      <div className="dir-browser-bar">
        <button type="button" className="icon-button" aria-label={t("Parent folder")} title={t("Parent folder")} disabled={!listing?.parent || loading} onClick={() => listing?.parent && open(listing.parent)}>
          <ArrowUp aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label={t("Home folder")} title={t("Home folder")} disabled={loading || (listing !== null && listing.path === listing.home)} onClick={() => open("")}>
          <House aria-hidden="true" />
        </button>
        <span className="dir-browser-path" title={path}><span dir="ltr">{shown}</span></span>
      </div>
      {error !== null ? <p className="dir-browser-note dir-browser-error" role="alert">{failure}</p> : (
        <ul className="dir-browser-list" ref={listRef}>
          {listing === null && <li className="dir-browser-note" role="status">{t("Loading…")}</li>}
          {listing?.directories.map((name) => (
            <li key={name}>
              <button type="button" className="dir-browser-item" disabled={loading} onClick={() => open(childPath(path, name))}>
                <Folder aria-hidden="true" />
                <span>{name}</span>
              </button>
            </li>
          ))}
          {files && listing?.files?.map((file) => (
            <li key={`file:${file.name}`}>
              <button type="button" className="dir-browser-item is-file" disabled={loading} onClick={() => emit({ type: "open-folder-file", path: childPath(path, file.name) })}>
                <FileText aria-hidden="true" />
                <span>{file.name}</span>
                <span className="dir-browser-size">{formatBytes(file.size)}</span>
              </button>
            </li>
          ))}
          {listing !== null && listing.directories.length === 0 && (listing.files ?? []).length === 0 && <li className="dir-browser-note">{t(files ? "Nothing here" : "No folders here")}</li>}
          {listing?.truncated && <li className="dir-browser-note">{t("Showing the first {n} folders; type the rest of the path to go further.", { n: listing.directories.length })}</li>}
        </ul>
      )}
      <div className="dir-browser-footer">
        <label className="dir-browser-hidden">
          <input type="checkbox" checked={hidden} disabled={loading && listing === null} onChange={(event) => emit({ type: "show-hidden-folders", hidden: event.target.checked })} />
          {t("Show hidden")}
        </label>
        {canPick && <button type="button" className="btn btn-primary" disabled={listing === null || loading} onClick={() => listing && emit({ type: "pick-folder", path: homeRelative(listing.path, listing.home) })}>
          {t("Use this folder")}
        </button>}
      </div>
    </div>
  );
}
