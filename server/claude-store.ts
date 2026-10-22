/**
 * Where Claude Code keeps a session's transcript: `~/.claude/projects/<project>/<session>.jsonl`.
 *
 * <project> is Claude's own encoding of the directory it started in (read from Claude Code
 * 2.1.284): every character that is not an ASCII letter or digit becomes `-`, and a name longer
 * than 200 characters keeps its first 200 plus `-` and a base-36 hash of the whole path. So
 * `my_project`, `example.com`, `.dotfiles`, `My Project` and a Korean folder all differ from a
 * plain `/` → `-` swap.
 *
 * The directory is only the fast path. The pane's cwd need not be the one Claude started in, and
 * Claude may change its encoding again, so a miss looks the session id up in every project: the
 * id is a UUID herdr reports, so at most one file answers to it.
 */

import { constants } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_PROJECT_NAME = 200;

/** Java's String.hashCode, which Claude Code uses for the suffix of a long name. */
function stringHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash << 5) - hash + text.charCodeAt(i) | 0;
  return hash;
}

export function claudeProjectDir(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_PROJECT_NAME) return name;
  return `${name.slice(0, MAX_PROJECT_NAME)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

/** Only an absent path is a miss: an unreadable store is an error to report, not an empty one. */
function absent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch (error) { if (absent(error)) return false; throw error; }
}

/** Store + session id → the file a project scan found it in; checked again on every use. */
const found = new Map<string, string>();

export function forgetClaudeSessions(): void {
  found.clear();
}

/**
 * Claude's native PID record names the current session even without Herdr's hook.
 * Linux's exact process-start ticks reject leftovers after a PID is reused. Read
 * again on every request: /clear and resume can change sessions in the same process.
 * Other platforms and older records without procStart keep the hook-only path.
 */
export async function claudeProcessSession(home: string, pid: number): Promise<string | null> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // Non-blocking and no symlinks: a FIFO or a link in the record's place must not hang the read.
    const file = await open(join(home, ".claude", "sessions", `${pid}.json`), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    let text: string;
    try {
      if (!(await file.stat()).isFile()) return null;
      const bytes = Buffer.alloc(16 * 1024 + 1);
      let length = 0;
      // One read may return less than the file holds; only a read of nothing is its end.
      for (;;) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length === bytes.length) return null;
      }
      text = bytes.subarray(0, length).toString("utf8");
    } finally { await file.close(); }
    const record: unknown = JSON.parse(text);
    if (record === null || typeof record !== "object" ||
      !("pid" in record) || record.pid !== pid ||
      !("kind" in record) || record.kind !== "interactive" ||
      !("sessionId" in record) || typeof record.sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.sessionId) ||
      !("procStart" in record) || typeof record.procStart !== "string" || !/^\d+$/.test(record.procStart)) return null;
    const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = processStat.slice(processStat.lastIndexOf(") ") + 2).split(" ");
    if (fields[19] !== record.procStart) return null;
    return record.sessionId;
  } catch (error) {
    // A closed process, absent/older native store or a torn write gives no identity.
    if (error instanceof SyntaxError || absent(error) ||
      (error !== null && typeof error === "object" && "code" in error && ["EACCES", "EPERM", "ESRCH", "ELOOP", "ENXIO"].includes(String(error.code)))) return null;
    throw error;
  }
}

/**
 * The transcript of `session` (a UUID, validated by the caller): under the project of each cwd
 * in turn, else in whichever project holds it. Null when no project does (a session that has not
 * written its first message yet). Such a session is scanned again on every poll, so the scan
 * stays off the event loop.
 */
export async function claudeTranscriptFile(home: string, session: string, cwds: readonly (string | null | undefined)[]): Promise<string | null> {
  const projects = join(home, ".claude", "projects");
  const file = `${session}.jsonl`;
  for (const cwd of cwds) {
    if (!cwd) continue;
    const path = join(projects, claudeProjectDir(cwd), file);
    if (await isFile(path)) return path;
  }
  const key = `${projects}\0${session}`;
  const known = found.get(key);
  if (known !== undefined && await isFile(known)) return known;
  found.delete(key);
  let entries: string[];
  try { entries = await readdir(projects); } catch (error) { if (absent(error)) return null; throw error; }
  // one unreadable project must not hide the session in another: an error counts only without a hit
  const checks = await Promise.allSettled(entries.map(async (entry) => {
    const path = join(projects, entry, file);
    return await isFile(path) ? path : null;
  }));
  for (const check of checks) {
    if (check.status === "fulfilled" && check.value !== null) { found.set(key, check.value); return check.value; }
  }
  const failed = checks.find((check) => check.status === "rejected");
  if (failed) throw failed.reason;
  return null;
}
