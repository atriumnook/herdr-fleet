import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { t } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { UiEvent } from "../ui/state.ts";

export interface FilesDialogModel {
  /** the folder to open at: the pane's own */
  start: string;
  /** a file is open above this dialog: Escape belongs to the viewer, which closes first */
  viewing: boolean;
}

export type FilesDialogEvent = Extract<UiEvent, { type: "close-files" | "open-file" }>;

export interface FilesDialogProps {
  model: FilesDialogModel;
  /** the parent's folder browser, starting at `start`; `open` opens a file in the viewer */
  browser: (start: string, open: (path: string) => void) => ReactNode;
  emit: Emit<FilesDialogEvent>;
}

/** The files of the pane's folder (and any other), each opened in the file viewer. */
export function FilesDialog({ model, browser, emit }: FilesDialogProps) {
  const { start, viewing } = model;
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const onClose = (): void => emit({ type: "close-files" });
  useEffect(() => {
    if (viewing) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") emitRef.current({ type: "close-files" }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal files-dialog" role="dialog" aria-modal="true" aria-labelledby="files-dialog-title">
        <header className="modal-header">
          <h2 className="modal-title" id="files-dialog-title">{t("Files")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close files")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          {browser(start, (path) => emit({ type: "open-file", path }))}
        </div>
      </section>
    </div>
  );
}
