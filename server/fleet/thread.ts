/**
 * A thread: one piece of a project's work with its own herdr workspace and, in a repository, its
 * own worktree on a branch, worked by a lead agent that hands parts on as tabs of that workspace.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiffStat } from "../../shared/fleet.ts";

const SETUP_TIMEOUT_MS = 10 * 60_000;
const SETUP_TAIL_LINES = 20;

/**
 * The repository `cwd` lies in, or null. The folder may be one nobody vetted, so git runs with
 * core.fsmonitor off, as server/files.ts does.
 */
export async function gitRoot(cwd: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-C", cwd, "rev-parse", "--show-toplevel"], {
    stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), 3_000);
  try {
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 && output.trim() ? output.trim() : null;
  } finally {
    clearTimeout(timer);
  }
}

/** A git command's output, or null when it fails or takes longer than `timeoutMs`; core.fsmonitor off, as in gitRoot. */
async function gitOutput(cwd: string, args: string[], timeoutMs = 5_000): Promise<string | null> {
  const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 ? output : null;
  } finally {
    clearTimeout(timer);
  }
}

/** The commit `cwd` is at: a thread's change is later measured against it. */
export async function gitHead(cwd: string): Promise<string | null> {
  const head = (await gitOutput(cwd, ["rev-parse", "HEAD"]))?.trim();
  return head && /^[0-9a-f]{7,64}$/.test(head) ? head : null;
}

/** What the worktree at `cwd` changed since `base`, committed or not, in the files git tracks (a binary file counts no lines). */
export async function diffStat(cwd: string, base: string): Promise<DiffStat | null> {
  const output = await gitOutput(cwd, ["diff", "--numstat", base, "--"]);
  if (output === null) return null;
  const rows = output.split("\n").filter(Boolean).map((line) => line.split("\t"));
  const count = (value: string | undefined) => (value && /^\d+$/.test(value) ? Number(value) : 0);
  return { added: rows.reduce((sum, row) => sum + count(row[0]), 0), removed: rows.reduce((sum, row) => sum + count(row[1]), 0), files: rows.length };
}

/** Where a thread's worktree goes: inside the repository, which the agent CLIs already trust (claude, codex and cursor ask nothing there). */
export const THREAD_WORKTREES = ".herdr-fleet/worktrees";

/**
 * Keeps the threads' worktrees out of the repository's own `git status`, through its local
 * `info/exclude`: the repository's .gitignore stays as it is, and nothing of this is committed.
 */
export async function excludeWorktrees(repo: string): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0 || !output.trim()) return;
  const file = join(output.trim(), "info", "exclude");
  const line = `/${THREAD_WORKTREES}/`;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((entry) => entry.trim() === line)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

export interface SetupOutcome { ok: boolean; output: string }

/**
 * The user's setup command for a fresh worktree (dependencies are not in a new checkout), in a
 * shell there. It comes from the user's own fleet.json only (config.ts): never from the repository.
 */
export async function runSetup(cwd: string, command: string, signal?: AbortSignal): Promise<SetupOutcome> {
  const proc = Bun.spawn(["sh", "-c", command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const kill = () => proc.kill();
  const timer = setTimeout(kill, SETUP_TIMEOUT_MS);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const output = `${out}${err}`.trimEnd().split("\n").slice(-SETUP_TAIL_LINES).join("\n");
    return { ok: exitCode === 0, output };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}
