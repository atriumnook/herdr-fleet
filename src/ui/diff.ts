/**
 * A unified diff (`git diff`, with a/ and b/ before the paths, as server/fleet/thread.ts asks for)
 * read into files and lines, for a thread's Changes view.
 */

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  /** the line's number in the old file and in the new one, where it has one */
  old?: number;
  new?: number;
  text: string;
}

export interface DiffFile {
  path: string;
  /** the path before a rename */
  from?: string;
  added: number;
  removed: number;
  binary: boolean;
  lines: DiffLine[];
}

/** A path from a `---`/`+++` line: without its a/ or b/, unquoted; null for /dev/null. */
function headerPath(raw: string): string | null {
  let path = raw.replace(/\t.*$/, "");
  if (path.startsWith("\"") && path.endsWith("\"")) path = path.slice(1, -1).replace(/\\(.)/g, "$1");
  if (path === "/dev/null") return null;
  return path.replace(/^[ab]\//, "");
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // the path until the ---/+++ lines name it: `diff --git a/x b/x`
      const match = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      file = { path: match?.[2] ?? line.slice(11), added: 0, removed: 0, binary: false, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (line.startsWith("rename from ")) file.from = line.slice(12);
      else if (line.startsWith("rename to ")) file.path = line.slice(10);
      else if (line.startsWith("Binary files ")) file.binary = true;
      else if (line.startsWith("--- ")) {
        const from = headerPath(line.slice(4));
        if (from !== null && from !== file.path) file.from ??= from;
      } else if (line.startsWith("+++ ")) {
        const to = headerPath(line.slice(4));
        if (to !== null) file.path = to;
        else if (file.from) { file.path = file.from; delete file.from; }
      }
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      file.lines.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) { file.lines.push({ kind: "add", new: newLine++, text: line.slice(1) }); file.added += 1; }
    else if (line.startsWith("-")) { file.lines.push({ kind: "del", old: oldLine++, text: line.slice(1) }); file.removed += 1; }
    else if (line.startsWith(" ")) file.lines.push({ kind: "ctx", old: oldLine++, new: newLine++, text: line.slice(1) });
    // "\ No newline at end of file", and the empty line the output ends with
  }
  return files;
}
