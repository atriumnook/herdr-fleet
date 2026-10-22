import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";

import type { FileInfo, FileKind } from "../shared/protocol.ts";
import { filesNamed } from "./files.ts";

/**
 * Opening a file from the browser: the files agents write (a screenshot, a demo video, a
 * PDF, a log) seen on a phone that has no terminal to open them with.
 *
 * Nothing is read into memory to serve a file: the response is `Bun.file`, which Bun
 * streams from disk (sendfile where it can) and answers Range requests for, so a video
 * plays and seeks without the server holding more than its socket buffers. Only the
 * first bytes of a file are read, to tell text from binary.
 *
 * Only files under the pane's folder, the system temp folder or the fleet's results folder open
 * (fileRoots): the rest of the home folder holds sign-ins and keys the viewer has no reason to see,
 * and the rest of the state folder holds this server's own (paired devices, push subscriptions).
 */

/**
 * Where files may open from: the pane's folder, when there is a pane, the temp folder, and the
 * folder fleet runs hand their results in (`<stateDir>/fleet-results`), which chats link to.
 */
export function fileRoots(cwd: string | null, resultsDir: string): string[] {
  return cwd === null ? [tmpdir(), resultsDir] : [cwd, tmpdir(), resultsDir];
}

/** Whether `path`, symlinks resolved, lies inside one of `roots`. A path that cannot be resolved is outside. */
export function withinRoots(path: string, roots: readonly string[]): boolean {
  let real: string;
  try { real = realpathSync(path); } catch { return false; }
  return roots.some((root) => {
    let base: string;
    try { base = realpathSync(root); } catch { return false; }
    return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

/** A path as agents and people write it: absolute, `~/…`, or relative to the pane's folder. */
export function resolveFilePath(input: string, cwd: string | null): string | null {
  const path = input.trim();
  if (path === "") return null;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return cwd === null ? null : resolve(cwd, path);
}

const TEXT_TYPES = /^(?:text\/|application\/(?:json|javascript|typescript|xml|x-sh|toml|yaml|x-yaml|sql)|image\/svg\+xml)/;
const SNIFF_BYTES = 8192;

function kindOf(mime: string, path: string): FileKind {
  if (mime === "image/svg+xml") return "image";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html") return "html";
  if (TEXT_TYPES.test(mime)) return "text";
  // no known type (a .log, a dotfile, source without a registered extension): text when
  // its first bytes hold no NUL
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read).includes(0) ? "binary" : "text";
  } catch {
    return "binary";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The file a path means: as written, or — for a relative path that is not there — the one
 * file under the pane's folder whose path ends in it (agents often name `demo.mp4` without
 * `docs/screenshots/`). Several such files come back as candidates to choose from.
 */
export function locateFile(input: string, cwd: string | null): { info: FileInfo } | { candidates: string[] } | null {
  const path = resolveFilePath(input, cwd);
  const info = path === null ? null : fileInfo(path);
  if (info !== null) return { info };
  const relative = input.trim();
  if (cwd === null || relative === "" || isAbsolute(relative) || relative.startsWith("~") || relative.startsWith("../")) return null;
  const found = filesNamed(cwd, relative).map((match) => resolve(cwd, match));
  if (found.length === 1) {
    const only = fileInfo(found[0]!);
    return only === null ? null : { info: only };
  }
  return found.length > 1 ? { candidates: found } : null;
}

/** A relative fallback stays in its own folder, including after following symlinks. */
export function locateFileInFolder(input: string, folder: string): ReturnType<typeof locateFile> {
  const relative = input.trim();
  if (isAbsolute(relative) || relative.startsWith("~") || !resolve(folder, relative).startsWith(resolve(folder) + sep)) return null;
  const found = locateFile(relative, folder);
  if (found === null) return null;
  try {
    const root = realpathSync(folder) + sep;
    const paths = "info" in found ? [found.info.path] : found.candidates;
    return paths.every((path) => realpathSync(path).startsWith(root)) ? found : null;
  } catch { return null; /* a missing or unreadable target is not a fallback */ }
}

/** What the viewer needs to know about a file, or null when it is not a readable file. */
export function fileInfo(path: string): FileInfo | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const mime = Bun.file(path).type.split(";")[0] || "application/octet-stream";
  return { path, name: basename(path), size: stat.size, modified: stat.mtime.toISOString(), mime, kind: kindOf(mime, path) };
}

/**
 * Where an HTML page is drawn from: `/api/fs/view/<pane id, or ->/<absolute path>`. The file is a
 * path here, not a query, so the images, stylesheets and pages it names relative to itself
 * resolve to their files; the pane keeps the files under its folder open to them.
 */
export const FILE_VIEW_PREFIX = "/api/fs/view/";

/** The pane and the file a `/api/fs/view/…` path names, or null when it names none. */
export function parseViewPath(pathname: string): { paneId: string | null; path: string } | null {
  if (!pathname.startsWith(FILE_VIEW_PREFIX)) return null;
  const [pane = "", ...rest] = pathname.slice(FILE_VIEW_PREFIX.length).split("/");
  let segments: string[];
  let paneId: string;
  try {
    paneId = decodeURIComponent(pane);
    segments = rest.map(decodeURIComponent);
  } catch {
    return null;
  }
  if (paneId === "" || segments.length === 0 || segments.some((segment) => segment === "" || segment.includes("\0"))) return null;
  return { paneId: paneId === "-" ? null : paneId, path: resolve("/", ...segments) };
}

/** A Host header as a CSP source may hold it: a name or a bracketed address, and a port. */
const CSP_HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

/**
 * What an HTML page may load: the files of its pane's `/api/fs/view/` path, which the file
 * reads' own checks still decide, and nothing from elsewhere. The page keeps this origin, so
 * the browser sends those reads the app's cookies (a sandboxed page without it is an origin of
 * its own, and SameSite=Strict holds them back from a paired phone), and still runs no script
 * and sends no form.
 */
function pagePolicy(host: string | null, paneId: string | null): string {
  const files = host !== null && CSP_HOST.test(host) ? ` ${host}${FILE_VIEW_PREFIX}${paneId === null ? "-" : encodeURIComponent(paneId)}/` : "";
  return `sandbox allow-same-origin; default-src 'none'; img-src data:${files}; media-src${files || " 'none'"}; style-src 'unsafe-inline'${files}; font-src data:${files}`;
}

/**
 * The file itself. `download` asks the browser to save it. Answers are sandboxed (an HTML
 * or SVG file opened from this origin must not run script with the app's access): an HTML
 * page served as one (`page`, from its `/api/fs/view/` path) is drawn without its scripts,
 * and the stylesheets it names keep their type; any other HTML file and text are served as
 * plain text whatever their extension says they run as.
 */
export function fileResponse(info: FileInfo, download: boolean, page?: { host: string | null; paneId: string | null }): Response {
  const name = encodeURIComponent(info.name);
  const headers = new Headers({
    "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  const asPage = info.kind === "html" && page !== undefined && !download;
  if (asPage) {
    headers.set("content-security-policy", pagePolicy(page.host, page.paneId));
    // the page's links name its pane and folder: a site it links to is not told them
    headers.set("referrer-policy", "no-referrer");
  // a PDF is drawn by the browser's own viewer, which refuses a sandboxed document; its
  // scripts stay inside that viewer, never on this origin
  } else if (info.kind !== "pdf") headers.set("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  // text shows as text, whatever its extension says it runs as; a page's stylesheet stays one, or the browser ignores it
  const ownType = asPage || page !== undefined && info.mime === "text/css" || info.mime === "image/svg+xml";
  const type = !ownType && (info.kind === "text" || info.kind === "html") ? "text/plain; charset=utf-8" : info.mime;
  const file = Bun.file(info.path, { type });
  return new Response(file, { headers });
}
