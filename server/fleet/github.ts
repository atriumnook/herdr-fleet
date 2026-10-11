/**
 * A thread's pull request, read from GitHub through the gh CLI, signed in as the person. gh holds
 * its own sign-in: the fleet reads no token. Nothing here writes to GitHub; the agents do that,
 * once the person pressed the step (agents/lead.md, agents/coordinator.md).
 */

import type { PullRequest } from "../../shared/fleet.ts";

const GH_TIMEOUT_MS = 20_000;

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

/** A pull request and the commit its branch is at on GitHub. */
export type PullRequestReading = PullRequest & { head: string };

/**
 * The pull request of `branch` in the repository at `repo`, with its checks; null when the branch
 * has none. Throws what gh said when GitHub cannot be asked (gh missing, signed out, offline).
 */
export async function readPullRequest(repo: string, branch: string): Promise<PullRequestReading | null> {
  let viewed: Awaited<ReturnType<typeof gh>>;
  try {
    viewed = await gh(repo, ["pr", "view", branch, "--json", "number,url,state,headRefOid"]);
  } catch {
    throw new Error("The gh command is not installed.");
  }
  if (!viewed.ok) {
    if (/no pull requests found/i.test(viewed.error)) return null;
    throw new Error(viewed.error.split("\n")[0] || "gh could not read the pull request.");
  }
  const pr = JSON.parse(viewed.output) as { number: number; url: string; state: PullRequest["state"]; headRefOid: string };
  const checks = pr.state === "OPEN" ? await readChecks(repo, pr.number) : { checks: "none" as const };
  return { number: pr.number, url: pr.url, state: pr.state, head: pr.headRefOid, ...checks };
}

/** A pull request's checks, summed up: any failing (by name), else any still running, else passed, or none at all. */
async function readChecks(repo: string, number: number): Promise<Pick<PullRequest, "checks" | "failing">> {
  // gh exits 1 when a check failed and 8 while one runs, and prints them either way
  const listed = await gh(repo, ["pr", "checks", String(number), "--json", "name,bucket"]);
  let rows: Array<{ name: string; bucket: string }>;
  try { rows = JSON.parse(listed.output); } catch { return { checks: "none" }; }
  const failing = rows.filter((row) => row.bucket === "fail" || row.bucket === "cancel").map((row) => row.name);
  if (failing.length) return { checks: "fail", failing };
  if (rows.some((row) => row.bucket === "pending")) return { checks: "pending" };
  return { checks: rows.some((row) => row.bucket === "pass") ? "pass" : "none" };
}
