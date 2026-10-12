/**
 * Reads of the person's running OpenCode 2 background service through the CLI's own `opencode api`,
 * which finds the service and signs in to it, so this process holds no credential. Kept small and in
 * a module of its own: the conversation reader (feat/opencode-conversation, server/opencode-session.ts)
 * has the same two calls with more care (retries, a limit on CLIs at once); the two are to be merged
 * when that branch is rebased onto this one.
 *
 * `opencode api` starts the service when none runs, which would launch the person's daemon from a
 * model listing: `opencode service status` (a read) asks first, and no service means no list.
 */
import { childEnv, emptyWorkDir } from "./cli-child.ts";

const TIMEOUT_MS = 15_000;
/** a reply larger than this is no reply: a model list is tens of KB */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

export interface OpencodeCliOptions {
  /** the CLI's own folder, emptied before the call; the CLI runs nowhere else */
  workDir: string;
  command?: string;
  /** the server's environment; process.env when left out */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxReplyBytes?: number;
}

async function run(args: string[], options: OpencodeCliOptions): Promise<{ stdout: string; code: number }> {
  emptyWorkDir(options.workDir);
  const maxBytes = options.maxReplyBytes ?? MAX_REPLY_BYTES;
  // childEnv keeps HOME and XDG_* (where the CLI finds its service) and nothing of OPENCODE_*, API keys or herdr's session
  const child = Bun.spawn([options.command ?? "opencode", ...args], { cwd: options.workDir, stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...childEnv(options.env ?? process.env), OPENCODE_DISABLE_AUTOUPDATE: "true" } });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = child.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { child.kill("SIGKILL"); throw new Error(`opencode ${args[0]} answered more than ${maxBytes} bytes`); }
      chunks.push(value);
    }
    const code = await child.exited;
    if (code !== 0 && child.killed) throw new Error(`opencode ${args[0]} timed out`);
    return { stdout: Buffer.concat(chunks).toString("utf8"), code };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

/** Whether the background service runs. Never starts it; a 1.x `opencode` does not know `service`, exits with an error, and counts as no service. */
export async function opencodeServiceRunning(options: OpencodeCliOptions): Promise<boolean> {
  try {
    const { stdout, code } = await run(["service", "status"], options);
    return code === 0 && /^https?:\/\//.test(stdout.trim());
  } catch {
    return false;
  }
}

/** The JSON body of `opencode api GET <path>` on the running service; throws when it does not run, or answers with an error or no JSON. */
export async function opencodeApiGet(options: OpencodeCliOptions, path: string): Promise<unknown> {
  if (!(await opencodeServiceRunning(options))) throw new Error("no OpenCode service is running");
  const { stdout, code } = await run(["api", "GET", path], options);
  if (code !== 0) throw new Error(`opencode api exited with ${code}`);
  try { return JSON.parse(stdout); } catch { throw new Error("opencode api returned no JSON"); }
}
