/**
 * A thread: one piece of a project's work with its own herdr workspace and, in a repository, its
 * own worktree on a branch, worked by a lead agent that hands parts on as tabs of that workspace.
 */

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
