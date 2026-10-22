import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { fileViewUrl } from "../src/lib/api.ts";
import { fileInfo, fileResponse, locateFileInFolder, parseViewPath, resolveFilePath } from "./file-view.ts";

describe("file view", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-file-view-")); roots.push(root); return root; };

  it("resolves absolute, ~ and pane-relative paths", () => {
    expect(resolveFilePath("/a/b.txt", "/work")).toBe("/a/b.txt");
    expect(resolveFilePath("~/x.png", null)).toBe(join(homedir(), "x.png"));
    expect(resolveFilePath("docs/demo.mp4", "/work/app")).toBe("/work/app/docs/demo.mp4");
    expect(resolveFilePath("docs/demo.mp4", null)).toBeNull();
    expect(resolveFilePath("  ", "/work")).toBeNull();
  });

  it("tells media, text and binary apart, and is null for a folder or nothing", () => {
    const root = temp();
    writeFileSync(join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "run.log"), "line\n");
    writeFileSync(join(root, "blob"), Buffer.from([1, 0, 2]));
    writeFileSync(join(root, "notes"), "plain words");
    expect(fileInfo(join(root, "a.png"))!.kind).toBe("image");
    expect(fileInfo(join(root, "run.log"))!.kind).toBe("text");
    expect(fileInfo(join(root, "blob"))!.kind).toBe("binary");
    expect(fileInfo(join(root, "notes"))!.kind).toBe("text");
    expect(fileInfo(root)).toBeNull();
    expect(fileInfo(join(root, "missing"))).toBeNull();
  });

  it("draws an HTML page without its scripts, loading only its pane's files, and shows any other HTML as text", async () => {
    const root = temp();
    writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
    const info = fileInfo(join(root, "page.html"))!;
    expect(info.kind).toBe("html");

    const page = fileResponse(info, false, { host: "127.0.0.1:8787", paneId: "w1:p1" });
    expect(page.headers.get("content-type")).toStartWith("text/html");
    expect(page.headers.get("content-security-policy")).toBe("sandbox allow-same-origin; default-src 'none'; img-src data: 127.0.0.1:8787/api/fs/view/w1%3Ap1/; "
      + "media-src 127.0.0.1:8787/api/fs/view/w1%3Ap1/; style-src 'unsafe-inline' 127.0.0.1:8787/api/fs/view/w1%3Ap1/; font-src data: 127.0.0.1:8787/api/fs/view/w1%3Ap1/");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).toBe("<script>alert(1)</script>");

    // a Host that is no plain authority is never written into the policy: the page loads no files
    const odd = fileResponse(info, false, { host: "a.example; script-src *", paneId: null }).headers.get("content-security-policy");
    expect(odd).toBe("sandbox allow-same-origin; default-src 'none'; img-src data:; media-src 'none'; style-src 'unsafe-inline'; font-src data:");

    for (const response of [fileResponse(info, false), fileResponse(info, true, { host: "127.0.0.1:8787", paneId: null })]) {
      expect(response.headers.get("content-type")).toStartWith("text/plain");
      expect(response.headers.get("content-security-policy")).toStartWith("sandbox;");
    }
    expect(fileResponse(info, true).headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
  });

  it("reads the pane and the file from an /api/fs/view/ path, as the viewer writes it", () => {
    const url = fileViewUrl("/work/my docs/report.html", "w1:p1");
    expect(url).toBe("/api/fs/view/w1%3Ap1/work/my%20docs/report.html");
    expect(parseViewPath(url)).toEqual({ paneId: "w1:p1", path: "/work/my docs/report.html" });
    // a file the page names relative to itself, as the browser resolves it
    expect(parseViewPath(new URL("img/a%20b.png", `http://h${url}`).pathname)).toEqual({ paneId: "w1:p1", path: "/work/my docs/img/a b.png" });
    expect(parseViewPath(fileViewUrl("/tmp/x.html", null))).toEqual({ paneId: null, path: "/tmp/x.html" });
    expect(parseViewPath("/api/fs/view/w1%3Ap1/work/..%2F..%2Fetc/passwd")).toEqual({ paneId: "w1:p1", path: "/etc/passwd" });
    for (const bad of ["/api/fs/view/", "/api/fs/view/w1", "/api/fs/view//etc/passwd", "/api/fs/view/-/a/%E0", "/api/fs/view/-/a%00b", "/api/fs/file"]) expect(parseViewPath(bad)).toBeNull();
  });

  it("serves script as plain text, and a stylesheet as one only to a page", () => {
    const root = temp();
    writeFileSync(join(root, "run.js"), "alert(1)");
    writeFileSync(join(root, "style.css"), "h1 { color: red }");
    const page = { host: "127.0.0.1:8787", paneId: null };
    for (const response of [fileResponse(fileInfo(join(root, "run.js"))!, false), fileResponse(fileInfo(join(root, "run.js"))!, false, page), fileResponse(fileInfo(join(root, "style.css"))!, false)]) {
      expect(response.headers.get("content-type")).toStartWith("text/plain");
    }
    const style = fileResponse(fileInfo(join(root, "style.css"))!, false, page);
    expect(style.headers.get("content-type")).toStartWith("text/css");
    expect(style.headers.get("content-security-policy")).toStartWith("sandbox;");
  });
});

describe("locateFile", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("refuses parent traversal outside the Claude scratch fallback folder", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    const folder = join(root, "session");
    mkdirSync(folder);
    writeFileSync(join(root, "outside.txt"), "outside");
    expect(locateFileInFolder("../outside.txt", folder)).toBeNull();
  });

  it("resolves an in-folder Claude scratch fallback link", () => {
    const folder = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(folder);
    mkdirSync(join(folder, "scratchpad"));
    const path = join(folder, "scratchpad", "notes.txt");
    writeFileSync(path, "notes");
    expect(locateFileInFolder("scratchpad/notes.txt", folder)).toMatchObject({ info: { path } });
  });

  it("refuses absolute paths and symlink escapes from the scratch fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    const folder = join(root, "session");
    mkdirSync(folder);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(folder, "linked.txt"));
    expect(locateFileInFolder(outside, folder)).toBeNull();
    expect(locateFileInFolder("linked.txt", folder)).toBeNull();
  });

  it("finds a bare name deeper in the pane's folder, and lists several of that name", async () => {
    const { mkdirSync } = await import("node:fs");
    const { locateFile } = await import("./file-view.ts");
    const { clearFileCache } = await import("./files.ts");
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    mkdirSync(join(root, "docs/screenshots"), { recursive: true });
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "docs/screenshots/demo.mp4"), "x");
    writeFileSync(join(root, "a/notes.md"), "a");
    writeFileSync(join(root, "b/notes.md"), "b");
    clearFileCache();
    expect(locateFile("demo.mp4", root)).toMatchObject({ info: { path: join(root, "docs/screenshots/demo.mp4") } });
    expect(locateFile("screenshots/demo.mp4", root)).toMatchObject({ info: { name: "demo.mp4" } });
    expect(locateFile("notes.md", root)).toEqual({ candidates: [join(root, "a/notes.md"), join(root, "b/notes.md")] });
    expect(locateFile("missing.txt", root)).toBeNull();
    // an absolute or ~ path is taken as written, never searched for
    expect(locateFile("/nowhere/demo.mp4", root)).toBeNull();
  });
});

describe("withinRoots", () => {
  const made: string[] = [];
  afterEach(() => { for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("opens files under a root and refuses the rest, a symlink out or a sibling with the same prefix included", async () => {
    const { mkdirSync, symlinkSync } = await import("node:fs");
    const { withinRoots } = await import("./file-view.ts");
    const base = mkdtempSync(join(tmpdir(), "herdr-roots-")); made.push(base);
    const pane = join(base, "pane");
    const outside = join(base, "pane-secrets");
    mkdirSync(join(pane, "docs"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(pane, "docs/shot.png"), "x");
    writeFileSync(join(outside, "id_ed25519"), "key");
    symlinkSync(join(outside, "id_ed25519"), join(pane, "link-out"));
    expect(withinRoots(join(pane, "docs/shot.png"), [pane])).toBe(true);
    expect(withinRoots(join(pane, "docs/../docs/shot.png"), [pane])).toBe(true);
    expect(withinRoots(join(outside, "id_ed25519"), [pane])).toBe(false);
    expect(withinRoots(join(pane, "../pane-secrets/id_ed25519"), [pane])).toBe(false);
    expect(withinRoots(join(pane, "link-out"), [pane])).toBe(false);
    expect(withinRoots(join(pane, "missing"), [pane])).toBe(false);
    expect(withinRoots(join(outside, "id_ed25519"), [pane, outside])).toBe(true);
  });

  it("lets a file open from the temp folder and the fleet's results without a pane, and from the pane's folder with one", async () => {
    const { fileRoots } = await import("./file-view.ts");
    expect(fileRoots(null, "/state/fleet-results")).toEqual([tmpdir(), "/state/fleet-results"]);
    expect(fileRoots("/work/app", "/state/fleet-results")).toEqual(["/work/app", tmpdir(), "/state/fleet-results"]);
  });
});
