import { FilesDialog, type FilesDialogEvent } from "../components/FilesDialog.tsx";
import type { Emit } from "./bubble.ts";
import { DirectoryBrowserPresenter, type FolderBrowserUpEvent } from "./DirectoryBrowserPresenter.tsx";
import { useSelected } from "./presenter.ts";

/** The Files dialog's Presenter: whether it and the viewer are open, and the selected pane's folder from the shell (null with no pane). Draws nothing while closed. */
export function FilesDialogPresenter({ start, emit }: { start: string | null; emit: Emit<FilesDialogEvent | FolderBrowserUpEvent> }) {
  const open = useSelected((state) => state.files.dialog);
  const viewing = useSelected((state) => state.files.viewer !== null);
  if (!open || start === null) return null;
  return <FilesDialog model={{ start, viewing }} browser={(from, pick) => <DirectoryBrowserPresenter slot="files" start={from} onOpenFile={pick} emit={emit} />} emit={emit} />;
}
