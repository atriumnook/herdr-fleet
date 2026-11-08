/**
 * A thread: one piece of a project's work with its own herdr workspace and, in a repository, its
 * own worktree on a branch, worked by a lead agent that hands parts on as tabs of that workspace.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** A git command's outcome, its output and what it said went wrong; core.fsmonitor off, as in gitRoot. */
async function git(cwd: string, args: string[], timeoutMs = 5_000): Promise<{ ok: boolean; output: string; error: string }> {
  // paths as they are (not octal-escaped), for the person to read
  const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [output, error, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { ok: exitCode === 0, output, error: error.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** A git command's output, or null when it fails or takes longer than `timeoutMs`. */
async function gitOutput(cwd: string, args: string[], timeoutMs = 5_000): Promise<string | null> {
  const outcome = await git(cwd, args, timeoutMs);
  return outcome.ok ? outcome.output : null;
}

/** The commit `cwd` is at: a thread's change is later measured against it. */
export async function gitHead(cwd: string): Promise<string | null> {
  const head = (await gitOutput(cwd, ["rev-parse", "HEAD"]))?.trim();
  return head && /^[0-9a-f]{7,64}$/.test(head) ? head : null;
}

/** The branch `cwd` is on; null when it is on none (a detached HEAD). */
export async function gitBranch(cwd: string): Promise<string | null> {
  return (await gitOutput(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() || null;
}

/**
 * What the worktree at `cwd` changed since it left `base` (a commit, or a branch it forked from),
 * committed or not, in the files git tracks (a binary file counts no lines).
 */
export async function diffStat(cwd: string, base: string): Promise<DiffStat | null> {
  const output = await gitOutput(cwd, ["diff", "--numstat", "--merge-base", base, "--"]);
  if (output === null) return null;
  const rows = output.split("\n").filter(Boolean).map((line) => line.split("\t"));
  const count = (value: string | undefined) => (value && /^\d+$/.test(value) ? Number(value) : 0);
  return { added: rows.reduce((sum, row) => sum + count(row[0]), 0), removed: rows.reduce((sum, row) => sum + count(row[1]), 0), files: rows.length };
}

/** the most of a thread's diff the fleet hands the screen */
export const DIFF_MAX_BYTES = 1024 * 1024;

/**
 * The same change as diffStat, as a unified diff with a/ and b/ before the paths from the
 * repository's top whatever the person's git config says, cut at DIFF_MAX_BYTES; null when git cannot say.
 */
export async function diffText(cwd: string, base: string): Promise<{ diff: string; truncated: boolean } | null> {
  const output = await gitOutput(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--merge-base", base, "--"], 15_000);
  if (output === null) return null;
  const bytes = Buffer.from(output);
  return bytes.length > DIFF_MAX_BYTES ? { diff: bytes.subarray(0, DIFF_MAX_BYTES).toString("utf8"), truncated: true } : { diff: output, truncated: false };
}

const UNCOMMITTED_MAX = 20;

/** The worktree's state beside the branch it lands on: what no commit holds, and the commits either side has that the other does not. */
export async function branchState(cwd: string, base: string): Promise<{ uncommitted: string[]; ahead: number; behind: number } | null> {
  const [status, counts] = await Promise.all([
    gitOutput(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    gitOutput(cwd, ["rev-list", "--left-right", "--count", `${base}...HEAD`]),
  ]);
  const [behind, ahead] = counts?.trim().split(/\s+/).map(Number) ?? [];
  if (status === null || behind === undefined || ahead === undefined || Number.isNaN(behind) || Number.isNaN(ahead)) return null;
  const uncommitted = status.split("\n").filter(Boolean).map((line) => line.slice(3)).slice(0, UNCOMMITTED_MAX);
  return { uncommitted, ahead, behind };
}

/** The commit a branch points at, or null. */
export async function branchHead(repo: string, branch: string): Promise<string | null> {
  return (await gitOutput(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]))?.trim() || null;
}

/** Whether every commit of `branch` is in `into`. */
export async function isMerged(repo: string, branch: string, into: string): Promise<boolean> {
  return (await git(repo, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/heads/${into}`])).ok;
}

/**
 * Removes a thread's worktree and then its branch. A worktree holding work no commit has stays
 * (files git ignores, such as installed dependencies, do not count), and so does a branch git does
 * not call merged into the checked-out branch, unless `force` says to throw the thread away, or
 * `branchMerged` says the fleet saw its commits merged where git cannot (a pull request on GitHub).
 * Answers what stayed and why.
 */
export async function removeThread(repo: string, worktree: string, branch: string, options: { force?: boolean; branchMerged?: boolean } = {}): Promise<string | undefined> {
  if (existsSync(worktree)) {
    const removed = await git(repo, ["worktree", "remove", ...(options.force ? ["--force"] : []), worktree], 60_000);
    if (!removed.ok) return `The worktree ${worktree} was kept: ${removed.error || "git could not remove it"}`;
  }
  const deleted = await git(repo, ["branch", options.force || options.branchMerged ? "-D" : "-d", branch]);
  if (!deleted.ok && !/not found/.test(deleted.error)) return `The branch ${branch} was kept: ${deleted.error || "git could not delete it"}`;
  return undefined;
}

/** Where a thread's worktree goes: inside the repository, which the agent CLIs already trust (claude, codex and cursor ask nothing there). */
export const THREAD_WORKTREES = ".herdr-fleet/worktrees";

/** The git folder a repository's worktrees share (`<repo>/.git`), from any of its worktrees. */
async function gitCommonDir(cwd: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return exitCode === 0 && output.trim() ? output.trim() : null;
}

/**
 * The repository's main worktree, from any of its worktrees: a thread's worktree gives the project
 * its fleet knows it by. A bare repository, which has no main worktree, gives the folder's own root.
 */
export async function mainWorktree(cwd: string): Promise<string | null> {
  const [root, common] = await Promise.all([gitRoot(cwd), gitCommonDir(cwd)]);
  if (!root || !common || basename(common) !== ".git") return root;
  return dirname(common);
}

/**
 * Keeps the threads' worktrees out of the repository's own `git status`, through its local
 * `info/exclude`: the repository's .gitignore stays as it is, and nothing of this is committed.
 */
export async function excludeWorktrees(repo: string): Promise<void> {
  const common = await gitCommonDir(repo);
  if (!common) return;
  const file = join(common, "info", "exclude");
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
