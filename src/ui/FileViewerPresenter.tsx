import { FileViewer, type FileViewerEvent } from "../components/FileViewer.tsx";
import { fileUrl, fileViewUrl } from "../lib/api.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import type { Emit } from "./bubble.ts";
import { DirectoryBrowserPresenter, type FolderBrowserUpEvent } from "./DirectoryBrowserPresenter.tsx";
import { useSelected } from "./presenter.ts";

/** The file viewer's Presenter: its region, and where its PC serves the file. Draws nothing while no file is open. */
export function FileViewerPresenter({ emit }: { emit: Emit<FileViewerEvent | FolderBrowserUpEvent> }) {
  const viewer = useSelected((state) => state.files.viewer);
  if (viewer === null) return null;
  const { path, content, preview: { paneId, machineId } } = viewer;
  // the file found (a bare name may have been found deeper in the folder), else as asked
  const found = content.kind === "file" ? content.info.path : path;
  // an HTML page is served at a path of its own, so the files it names relative to itself load
  const url = content.kind === "file" && content.info.kind === "html" ? fileViewUrl(found, paneId, machineId) : fileUrl(found, paneId, machineId);
  const model = { path, content, url, downloadUrl: fileUrl(found, paneId, machineId, true) };
  // each file its entry keeps is a viewer of its own (scrolled to its top); the folder browser reads the viewer's PC
  return (
    <MachineContext.Provider value={machineId}>
      <FileViewer key={viewer.preview.path} model={model} browser={(start, open) => <DirectoryBrowserPresenter slot="viewer" start={start} onOpenFile={open} emit={emit} />} emit={emit} />
    </MachineContext.Provider>
  );
}
