import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { FileInfo } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import type { FileContent } from "../ui/state.ts";
import { FileViewer, type FileViewerModel } from "./FileViewer.tsx";
import { FilesDialog } from "./FilesDialog.tsx";
import { t } from "../lib/i18n.ts";

const info = (extra: Partial<FileInfo> = {}): FileInfo => ({ path: "/w/notes.txt", name: "notes.txt", size: 12, modified: "", mime: "text/plain", kind: "text", ...extra });
const model = (content: FileContent, path = "notes.txt"): FileViewerModel => ({ path, content, url: "/api/fs/file?path=x", downloadUrl: "/api/fs/file?path=x&download=1" });

/** English, as under the app's own provider with an English browser */
function render(element: ReturnType<typeof createElement>): string {
  return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: element }));
}
const viewer = (values: FileViewerModel) => render(createElement(FileViewer, { model: values, browser: (start) => createElement("p", null, `browsing ${start}`), emit: () => {} }));

describe("File viewer view", () => {
  it("names the path asked while it opens, and the file found once read", () => {
    expect(viewer(model({ kind: "opening" }))).toContain("Opening…");
    const html = viewer(model({ kind: "file", info: info({ path: "/w/docs/notes.txt" }), text: "hello" }));
    expect(html).toContain('aria-label="notes.txt"');
    expect(html).toContain("/w/docs/notes.txt");
    expect(html).toContain('<pre class="file-viewer-text">hello</pre>');
    expect(html).toContain('href="/api/fs/file?path=x&amp;download=1"');
  });

  it("says a text file's start is all it shows", () => {
    expect(viewer(model({ kind: "file", info: info({ size: 1024 * 1024 }), text: "a" }))).toContain(t("Showing the first {shown} of {total}.", { shown: "256 KB", total: "1 MB" }));
    expect(viewer(model({ kind: "file", info: info(), text: null }))).toContain("Opening…");
  });

  it("draws media from where the file is served", () => {
    expect(viewer(model({ kind: "file", info: info({ kind: "video", name: "a.webm" }), text: null }))).toContain('<video class="file-viewer-media" src="/api/fs/file?path=x"');
  });

  it("offers each of several files of the name, lists a folder, and says why a file did not open", () => {
    const several = viewer(model({ kind: "candidates", candidates: ["/w/a/notes.txt", "/w/b/notes.txt"] }));
    expect(several).toContain(t("Several files are named {name}.", { name: "notes.txt" }));
    expect(several).toContain(">/w/b/notes.txt</button>");
    expect(viewer(model({ kind: "folder", path: "/w/src" }, "src"))).toContain("browsing /w/src");
    expect(viewer(model({ kind: "failed", reason: "outside" }))).toContain(t("Only files in the pane's folder, the temp folder or the fleet's results open here."));
    expect(viewer(model({ kind: "failed", reason: "missing" }))).toContain(t("No readable file at this path."));
  });
});

describe("Files dialog view", () => {
  it("browses from the pane's folder", () => {
    const html = render(createElement(FilesDialog, { model: { start: "/w", viewing: false }, browser: (start) => createElement("p", null, `browsing ${start}`), emit: () => {} }));
    expect(html).toContain(">Files</h2>");
    expect(html).toContain("browsing /w");
  });
});
