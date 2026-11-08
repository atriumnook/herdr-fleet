/**
 * A thread's pull request, read from GitHub through the gh CLI, signed in as the person. gh holds
 * its own sign-in: the fleet reads no token. Nothing here writes to GitHub; the agents do that,
 * once the person pressed the step (agents/lead.md, agents/coordinator.md), or once the fleet found
 * every condition of a project's merge gate held (merge-mode.ts). The git reads the gate and the
 * merge records rest on are here too, and change nothing either.
 */

import type { PullRequest } from "../../shared/fleet.ts";

const GH_TIMEOUT_MS = 20_000;
const SHA = /^[0-9a-f]{7,64}$/;
/** a branch name as it goes into a path of GitHub's API and a git revision: nothing a shell or git would read as more */
const BRANCH = /^[\w][\w./-]{0,199}$/;

async function gh(cwd: string, args: string[]): Promise<{ ok: boolean; output: string; error: string }> {
  const proc = Bun.spawn(["gh", ...args], {
    cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
  try {
    const [output, error, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { ok: exitCode === 0, output, error: error.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A pull request and the commit its branch is at on GitHub, the branch it targets, its merge commit
 * once merged, and whether its checks were read (`checks: "none"` from a failed read is not "no checks").
 */
export type PullRequestReading = PullRequest & { head: string; base?: string; mergeCommit?: string; checksRead?: boolean };

/**
 * The pull request of `branch` in the repository at `repo`, with its checks; null when the branch
 * has none. Throws what gh said when GitHub cannot be asked (gh missing, signed out, offline).
 */
export async function readPullRequest(repo: string, branch: string): Promise<PullRequestReading | null> {
  let viewed: Awaited<ReturnType<typeof gh>>;
  try {
    viewed = await gh(repo, ["pr", "view", branch, "--json", "number,url,state,headRefOid,baseRefName,mergeCommit"]);
  } catch {
    throw new Error("The gh command is not installed.");
  }
  if (!viewed.ok) {
    if (/no pull requests found/i.test(viewed.error)) return null;
    throw new Error(viewed.error.split("\n")[0] || "gh could not read the pull request.");
  }
  const pr = JSON.parse(viewed.output) as { number: number; url: string; state: PullRequest["state"]; headRefOid: string; baseRefName?: string; mergeCommit?: { oid?: string } | null };
  const checks = pr.state === "OPEN" ? await readChecks(repo, pr.number) : { checks: "none" as const, read: false };
  const mergeCommit = pr.state === "MERGED" && typeof pr.mergeCommit?.oid === "string" && SHA.test(pr.mergeCommit.oid) ? pr.mergeCommit.oid : undefined;
  const { read, ...summed } = checks;
  return {
    number: pr.number, url: pr.url, state: pr.state, head: pr.headRefOid, ...summed, checksRead: read,
    ...(typeof pr.baseRefName === "string" ? { base: pr.baseRefName } : {}), ...(mergeCommit ? { mergeCommit } : {}),
  };
}

/**
 * A pull request's checks, summed up: any failing (by name), else any still running, else passed,
 * or none at all; `read` says whether gh answered, so a failed read is not taken for no checks.
 */
async function readChecks(repo: string, number: number): Promise<Pick<PullRequest, "checks" | "failing"> & { read: boolean }> {
  // gh exits 1 when a check failed and 8 while one runs, and prints them either way
  const listed = await gh(repo, ["pr", "checks", String(number), "--json", "name,bucket"]);
  let rows: Array<{ name: string; bucket: string }>;
  try { rows = JSON.parse(listed.output); } catch { return { checks: "none", read: /no checks reported/i.test(listed.error) }; }
  if (!Array.isArray(rows)) return { checks: "none", read: false };
  const failing = rows.filter((row) => row.bucket === "fail" || row.bucket === "cancel").map((row) => row.name);
  if (failing.length) return { checks: "fail", failing, read: true };
  if (rows.some((row) => row.bucket === "pending")) return { checks: "pending", read: true };
  return { checks: rows.some((row) => row.bucket === "pass") ? "pass" : "none", read: true };
}

/** A pull request merged, as the factory's metrics read it. */
export interface MergedPullRequest { number: number; title: string; mergedAt: string; baseRefName: string }
/** An issue, as the factory's metrics read it. */
export interface IssueSummary { number: number; title: string; createdAt: string; closedAt: string | null; labels: { name: string }[] }

async function ghJson<T>(repo: string, args: string[]): Promise<T> {
  let listed: Awaited<ReturnType<typeof gh>>;
  try { listed = await gh(repo, args); } catch (error) { throw new Error(`The gh command could not be run: ${error instanceof Error ? error.message : String(error)}`); }
  if (!listed.ok) throw new Error(listed.error || `gh ${args.slice(0, 2).join(" ")} failed or timed out.`);
  try { return JSON.parse(listed.output) as T; } catch { throw new Error(`gh ${args.slice(0, 2).join(" ")} answered something other than JSON.`); }
}

/** The repository's merged pull requests, the latest 200. */
export function listMergedPullRequests(repo: string): Promise<MergedPullRequest[]> {
  return ghJson(repo, ["pr", "list", "--state", "merged", "--limit", "200", "--json", "number,title,mergedAt,baseRefName"]);
}

/** The repository's issues, open and closed, the latest 500. */
export function listIssues(repo: string): Promise<IssueSummary[]> {
  return ghJson(repo, ["issue", "list", "--state", "all", "--limit", "500", "--json", "number,title,createdAt,closedAt,labels"]);
}

/** A git command's output, or null when it fails; core.fsmonitor off, as thread.ts runs git. */
async function gitOutput(cwd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-C", cwd, ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 ? output : null;
  } finally {
    clearTimeout(timer);
  }
}

/** the most files GitHub's compare lists: a change with more is not measured */
const COMPARE_MAX_FILES = 300;

/**
 * What a pull request delivers, as GitHub compares the commit `head` with `base` there: the files it
 * changes (a rename counts as the old path and the new), the lines added and removed in all, and
 * how many commits `base` has that `head` does not. Null when GitHub cannot say, or lists so many
 * files that it may have cut the list.
 */
export async function compareOnGitHub(repo: string, base: string, head: string): Promise<{ files: string[]; lines: number; behind: number } | null> {
  if (!BRANCH.test(base) || !SHA.test(head)) return null;
  let compared: Awaited<ReturnType<typeof gh>>;
  try {
    compared = await gh(repo, ["api", `repos/{owner}/{repo}/compare/${base}...${head}`, "--jq", "{behind: .behind_by, files: [.files[]? | {f: .filename, p: .previous_filename, a: .additions, d: .deletions}]}"]);
  } catch {
    return null;
  }
  if (!compared.ok) return null;
  let parsed: { behind?: unknown; files?: Array<{ f?: unknown; p?: unknown; a?: unknown; d?: unknown }> };
  try { parsed = JSON.parse(compared.output); } catch { return null; }
  if (typeof parsed.behind !== "number" || !Array.isArray(parsed.files) || parsed.files.length >= COMPARE_MAX_FILES) return null;
  const files = new Set<string>();
  let lines = 0;
  for (const file of parsed.files) {
    if (typeof file.f !== "string" || typeof file.a !== "number" || typeof file.d !== "number") return null;
    files.add(file.f);
    if (typeof file.p === "string") files.add(file.p);
    lines += file.a + file.d;
  }
  return { files: [...files], lines, behind: parsed.behind };
}

/** Whether `base` on GitHub holds `commit` (null when GitHub cannot say): a revert pushed there, say. */
export async function onGitHub(repo: string, base: string, commit: string): Promise<boolean | null> {
  if (!BRANCH.test(base) || !SHA.test(commit)) return null;
  try {
    const compared = await gh(repo, ["api", `repos/{owner}/{repo}/compare/${commit}...${base}`, "--jq", ".status"]);
    const status = compared.output.trim();
    return compared.ok && status ? status === "identical" || status === "ahead" : null;
  } catch {
    return null;
  }
}

/** The commit the worktree at `cwd` is at, or null. */
export async function headCommit(cwd: string): Promise<string | null> {
  const sha = (await gitOutput(cwd, ["rev-parse", "HEAD"]))?.trim();
  return sha && SHA.test(sha) ? sha : null;
}

/**
 * The merge commit that brought `head` into `base` here (git merge --no-ff): the one whose merged
 * parent, the second, is `head`. Null when there is none, as after a fast-forward, or more than one.
 */
export async function mergeCommitOf(repo: string, head: string, base: string): Promise<string | null> {
  if (!BRANCH.test(base) || !SHA.test(head)) return null;
  const merges = (await gitOutput(repo, ["rev-list", "--merges", "--parents", "--ancestry-path", `${head}..refs/heads/${base}`]))?.split("\n").filter(Boolean) ?? [];
  const found = merges.map((line) => line.split(" ")).filter((shas) => shas[2] === head).map((shas) => shas[0]!);
  return found.length === 1 ? found[0]! : null;
}

/** The commit on `base` here that reverts `commit` (git revert's own message names it), or null. */
export async function revertOf(repo: string, base: string, commit: string): Promise<string | null> {
  if (!BRANCH.test(base) || !SHA.test(commit)) return null;
  const found = (await gitOutput(repo, ["log", `refs/heads/${base}`, "-F", `--grep=This reverts commit ${commit}`, "--format=%H", "-n", "1", "--"]))?.trim();
  return found && SHA.test(found) ? found : null;
}
