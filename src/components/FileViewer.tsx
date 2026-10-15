import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Code, Download, ExternalLink, X } from "lucide-react";

import "./FileViewer.css";

import { TEXT_PREVIEW_BYTES } from "../lib/api.ts";
import { formatBytes } from "../lib/formatBytes.ts";
import { t } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { FileContent, UiEvent } from "../ui/state.ts";

/** Bigger images are offered as a download: a phone decodes an image whole. */
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/** What the viewer draws: the path shown, what was read of it, and where the file itself is served. */
export interface FileViewerModel {
  /** absolute, `~/…`, or relative to the pane's folder */
  path: string;
  content: FileContent;
  /** the file found (a bare name may have been found deeper in the folder), else as asked */
  url: string;
  downloadUrl: string;
}

export type FileViewerEvent = Extract<UiEvent, { type: "close-file" | "viewer-open" | "choose-candidate" }>;

export interface FileViewerProps {
  model: FileViewerModel;
  /** the parent's folder browser for a folder at the path; `open` opens a file chosen in it */
  browser: (start: string, open: (path: string) => void) => ReactNode;
  emit: Emit<FileViewerEvent>;
}

/**
 * A file an agent wrote, opened in the browser: images, video and audio (streamed, so they
 * play and seek at once), PDFs, HTML pages (sandboxed, without their scripts, or their source), and the start of a text file. Anything can be downloaded.
 */
export function FileViewer({ model, browser, emit }: FileViewerProps) {
  const { path, content, url, downloadUrl } = model;
  const info = content.kind === "file" ? content.info : null;
  // an HTML page or its source: how this file is looked at, not what is known of it
  const [source, setSource] = useState(false);
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const onClose = (): void => emit({ type: "close-file" });

  useEffect(() => {
    // the FilesDialog beneath listens on window too (and stands down while this is open); this
    // one is the topmost overlay, so it takes the key
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") emitRef.current({ type: "close-file" }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const body = (() => {
    switch (content.kind) {
      case "folder":
        return <Fragment key={content.path}>{browser(content.path, (next) => emit({ type: "viewer-open", path: next }))}</Fragment>;
      case "failed":
        return <p className="file-viewer-note" role="alert">{content.reason === "outside" ? t("Only files in the pane's folder, the temp folder or the fleet's results open here.")
          : content.reason === "missing" ? t("No readable file at this path.") : t("The file could not be opened.")}</p>;
      case "candidates":
        return <div className="file-viewer-choices">
          <p className="file-viewer-note">{t("Several files are named {name}.", { name: path.split("/").pop() ?? path })}</p>
          <ul>{content.candidates.map((candidate) => <li key={candidate}><button type="button" className="btn btn-ghost" onClick={() => emit({ type: "choose-candidate", path: candidate })}>{candidate}</button></li>)}</ul>
        </div>;
      case "opening":
        return <p className="file-viewer-note">{t("Opening…")}</p>;
    }
    const { info, text } = content;
    const textBody = text === null ? <p className="file-viewer-note">{t("Opening…")}</p> : <>
      <pre className="file-viewer-text">{text}</pre>
      {info.size > TEXT_PREVIEW_BYTES && <p className="file-viewer-note">{t("Showing the first {shown} of {total}.", { shown: formatBytes(TEXT_PREVIEW_BYTES), total: formatBytes(info.size) })}</p>}
    </>;
    switch (info.kind) {
      case "image":
        return info.size > MAX_INLINE_IMAGE_BYTES
          ? <p className="file-viewer-note">This image is {formatBytes(info.size)}; download it to view.</p>
          : <img className="file-viewer-media" src={url} alt={info.name} />;
      case "video":
        return <video className="file-viewer-media" src={url} controls playsInline preload="metadata" />;
      case "audio":
        return <audio className="file-viewer-audio" src={url} controls preload="metadata" />;
      case "pdf":
        return <iframe className="file-viewer-pdf" src={url} title={info.name} />;
      case "html":
        if (source) return textBody;
        // the server sandboxes the page too; this keeps it from scripts, forms and popups if that header is lost.
        // It keeps this origin, so the files it names are read with the app's cookies
        return <>
          <iframe className="file-viewer-html" src={url} title={info.name} sandbox="allow-same-origin" />
          <p className="file-viewer-note">{t("Scripts on this page do not run, and nothing loads from the internet.")}</p>
        </>;
      case "text":
        return textBody;
      default:
        return <p className="file-viewer-note">{info.mime}, {formatBytes(info.size)}. This file can't be shown here; download it instead.</p>;
    }
  })();

  return (
    <div className="modal-scrim file-viewer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal file-viewer" role="dialog" aria-modal="true" aria-label={info?.name ?? path}>
        <header className="modal-header file-viewer-header">
          <div className="file-viewer-title">
            <h2 className="modal-title">{info?.name ?? path.split("/").pop()}</h2>
            <p className="file-viewer-meta" title={info?.path ?? path}>
              {info && <span className="file-viewer-size">{formatBytes(info.size)}</span>}
              <span className="file-viewer-path"><span dir="ltr">{info?.path ?? path}</span></span>
            </p>
          </div>
          {info?.kind === "html" && <button type="button" className="icon-button" aria-pressed={source} aria-label={t("Show source")} title={t("Show source")} onClick={() => setSource((shown) => !shown)}><Code aria-hidden="true" /></button>}
          <a className="icon-button" href={url} target="_blank" rel="noopener" aria-label={t("Open in a new tab")} title={t("Open in a new tab")}><ExternalLink aria-hidden="true" /></a>
          <a className="icon-button" href={downloadUrl} download={info?.name ?? true} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>
          <button type="button" className="icon-button" aria-label={t("Close file")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="file-viewer-body">{body}</div>
      </section>
    </div>
  );
}
