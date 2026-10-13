import { createContext } from "react";

/**
 * File paths in the chat, as agents write them ("saved to docs/demo.mp4", `~/out/x.png`),
 * opened in the file viewer. A bare path needs a folder in it and an extension, so words
 * like "and/or" or "e.g." stay text; code spans need only look like one file name.
 *
 * A name may be in any script (`/tmp/スクショ.png`). In prose a relative path's first folder is
 * ASCII, so text written up against it (`これはsrc/app.tsの`) is not read as part of it.
 */

const BARE_PATH = /(?<![\w/.@~-])((?:(?:~\/|\.{1,2}\/|\/)(?:[\p{L}\p{N}\p{M}_@.+-]+\/)+|[\w@.+-]+\/(?:[\p{L}\p{N}\p{M}_@.+-]+\/)*)[\p{L}\p{N}\p{M}_@+-][\p{L}\p{N}\p{M}_@.+-]*\.[A-Za-z0-9]{1,8})(?![\w/])/gu;
const CODE_PATH = /^(?:~\/|\.{1,2}\/|\/)?(?:[\p{L}\p{N}\p{M}_@.+-]+\/)*[\p{L}\p{N}\p{M}_@+-][\p{L}\p{N}\p{M}_@.+-]*\.[A-Za-z0-9]{1,8}$/u;

/**
 * A bare dotted name that is code or a host, not a file: what agents write in backticks all the
 * time (`process.env`, `Math.random`, `tool.monitor`). Named one
 * by one, not by the word before the dot: `tool.vue`, `os.conf` and `std.lock` are files, and
 * so is anything else with an extension, as a list of extensions always misses some.
 */
const CODE_NAME = /^(?:process\.(?:env|argv|cwd|exit|platform|stdout|stderr|stdin)(?:\.\w+)?|Math\.(?:random|floor|ceil|round|max|min|abs|pow|sqrt|trunc|sign)|JSON\.(?:parse|stringify)|console\.(?:log|error|warn|info|debug)|Object\.(?:keys|values|entries|assign|freeze)|Array\.(?:from|isArray)|Promise\.(?:all|race|any|allSettled|resolve|reject)|Number\.(?:isFinite|isInteger|parseInt|parseFloat)|tool\.(?:monitor|read|bash|grep|write|edit)|os\.(?:path|environ|getcwd|getenv)|sys\.(?:argv|path|exit|stdout|stderr)|window\.(?:location|history|open)|document\.(?:body|title|cookie))$/;
function isCodeName(name: string): boolean {
  return !name.includes("/") && CODE_NAME.test(name);
}

/** Text split into plain runs and the file paths in it. */
export function splitFilePaths(text: string): (string | { path: string })[] {
  const parts: (string | { path: string })[] = [];
  let offset = 0;
  for (const match of text.matchAll(BARE_PATH)) {
    const index = match.index ?? 0;
    // a version number or a domain is not a path: one of its segments must hold a letter
    if (!/\p{L}/u.test(match[1]!.replace(/\.[A-Za-z0-9]{1,8}$/, ""))) continue;
    if (index > offset) parts.push(text.slice(offset, index));
    parts.push({ path: match[1]! });
    offset = index + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

/** A code span that is a single file name or path (`README.md`, `src/app.ts`). */
export function codeIsFilePath(code: string): boolean {
  return CODE_PATH.test(code) && !isCodeName(code) && /\p{L}/u.test(code.replace(/\.[A-Za-z0-9]{1,8}$/, "")) && !/^\d+(?:\.\d+)+$/.test(code);
}

/** Opens a path in the file viewer; null where nothing can open one (paths stay text). */
export const OpenFileContext = createContext<((path: string) => void) | null>(null);

/** Where a chat's pane serves a path, to show an image the chat names; null where none is served. */
export const FileUrlContext = createContext<((path: string) => string) | null>(null);

/** A file a browser shows as an image, by its name: the kinds the server serves as images. */
export function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path);
}
