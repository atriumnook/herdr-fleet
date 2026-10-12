/**
 * Reads of the person's running OpenCode 2 background service through the CLI's own `opencode api`,
 * which finds the service and signs in to it, so this process holds no credential. The one place
 * the CLI is run from, for the model list (server/fleet/model-lists.ts) and the conversation
 * (server/opencode-session.ts).
 *
 * `opencode api` starts the service when none runs, which would launch the person's daemon from a
 * poll: `opencode service status` (a read) asks first, and no service means no read. A 1.x
 * `opencode` does not know `service`, exits with an error, and counts as no service.
 */
import { childEnv, emptyWorkDir } from "./cli-child.ts";
import { record } from "./transcript-records.ts";

const CLI_TIMEOUT_MS = 20_000;
/** after SIGTERM a CLI has this long before SIGKILL, and then as long again before the read is given up */
const KILL_GRACE_MS = 2_000;
/** a reply larger than this is no reply: 100 messages with a few large outputs is a few MB */
const MAX_REPLY_BYTES = 32 * 1024 * 1024;
const MAX_CHILDREN = 4;
/** `opencode service status` is asked at most this often: under the chat's own poll interval */
const SERVICE_TTL_MS = 1_000;

/** The CLI answered with an HTTP error: `status` is its code, `tag` the body's `_tag`. */
export class OpencodeHttpError extends Error {
  constructor(readonly status: number, readonly tag: string) {
    super(`opencode api answered ${status}${tag ? ` ${tag}` : ""}`);
    this.name = "OpencodeHttpError";
  }
}

export interface OpencodeApi {
  /** the parsed JSON body of a GET; throws OpencodeHttpError for an HTTP error, Error for a read that failed */
  get(path: string): Promise<unknown>;
  /** whether the background service answers; never starts it */
  serviceRunning(): Promise<boolean>;
}

export interface OpencodeCliOptions {
  /** the CLI's own folder; the CLI runs nowhere else */
  workDir: string;
  command?: string;
  /** the server's environment; process.env when left out */
  env?: Record<string, string | undefined>;
  /** how often a reply that exited 0 but was cut is read again */
  attempts?: number;
  timeoutMs?: number;
  killGraceMs?: number;
  maxReplyBytes?: number;
  /** CLIs running at once, whatever the number of panels and panes asking */
  maxChildren?: number;
}

/** The head of what a CLI said on stderr, as one printable line */
const head = (text: string): string => text.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 200);

/** Reads a stream to its end, keeping `limit` bytes; `over` says it held more (the reader then stops). */
async function readUpTo(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; over: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) return { text: "", over: true };
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks).toString("utf8"), over: false };
}

/**
 * `opencode api GET <path>` and `opencode service status`, run as a usage probe is: in a folder
 * of ours, with only the environment the CLI needs to find its service (HOME, XDG_*). Not
 * OPENCODE_*: a person who moves OpenCode's state with those would have this look at another
 * service than their pane uses, and read "stopped" (the pane stays on its scrollback).
 *
 * The CLI writes its reply and exits without waiting for the pipe to drain, so a large reply to a
 * pipe can arrive cut. A reply that exited 0 and is not JSON is read again. A CLI that timed out,
 * exited with an error, or answered too much is not: the same call would take as long again.
 */
export function opencodeCli(options: OpencodeCliOptions): OpencodeApi {
  const command = options.command ?? "opencode";
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  const maxBytes = options.maxReplyBytes ?? MAX_REPLY_BYTES;
  const limit = options.maxChildren ?? MAX_CHILDREN;
  let prepared = false;
  let running = 0;
  const waiting: (() => void)[] = [];
  let service: { at: number; running: boolean } | null = null;
  let asking: Promise<boolean> | null = null;

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try { return await work(); } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  type Ran = { stdout: string; stderr: string; code: number };
  function run(args: string[]): Promise<Ran> {
    return slot(async () => {
      // once: a second read must not empty the folder under a first one still running
      if (!prepared) { emptyWorkDir(options.workDir); prepared = true; }
      const child = Bun.spawn([command, ...args], { cwd: options.workDir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...childEnv(options.env ?? process.env), OPENCODE_DISABLE_AUTOUPDATE: "true" } });
      let timedOut = false;
      let giveUp: (error: Error) => void = () => {};
      const abandoned = new Promise<never>((_, reject) => { giveUp = reject; });
      const timers: ReturnType<typeof setTimeout>[] = [];
      timers.push(setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // a CLI that ignores SIGTERM, or a launcher whose child holds the pipe, must not hold a read for ever
        timers.push(setTimeout(() => {
          child.kill("SIGKILL");
          timers.push(setTimeout(() => giveUp(new Error(`opencode ${args[0]} timed out`)), grace));
        }, grace));
      }, timeoutMs));
      try {
        const [out, err, code] = await Promise.race([
          Promise.all([readUpTo(child.stdout, maxBytes), readUpTo(child.stderr, 4096).then((read) => read.text, () => ""), child.exited]),
          abandoned,
        ]);
        if (out.over) { child.kill("SIGKILL"); throw new Error(`opencode ${args[0]} answered more than ${maxBytes} bytes`); }
        if (timedOut) throw new Error(`opencode ${args[0]} timed out`);
        return { stdout: out.text, stderr: err, code };
      } finally {
        for (const timer of timers) clearTimeout(timer);
        child.kill("SIGKILL");
      }
    });
  }

  return {
    async get(path) {
      for (let attempt = 1; ; attempt += 1) {
        const { stdout, stderr, code } = await run(["api", "GET", path]);
        let body: unknown;
        try { body = JSON.parse(stdout); } catch {
          if (code === 0 && attempt < attempts) continue;
          throw new Error(`opencode api returned no JSON (exit ${code}${stderr.trim() ? `: ${head(stderr)}` : ""})`);
        }
        if (code === 0) return body;
        const status = /HTTP (\d{3})/.exec(stderr)?.[1];
        throw new OpencodeHttpError(status === undefined ? 0 : Number(status), String(record(body)["_tag"] ?? ""));
      }
    },
    serviceRunning() {
      const now = Date.now();
      if (service !== null && now - service.at < SERVICE_TTL_MS) return Promise.resolve(service.running);
      // one question at a time: panels asking together share the answer
      asking ??= (async () => {
        let answer = false;
        try {
          const { stdout, code } = await run(["service", "status"]);
          answer = code === 0 && /^https?:\/\//.test(stdout.trim());
        } catch { /* a status that cannot be asked is a service not known to run */ }
        service = { at: Date.now(), running: answer };
        return answer;
      })().finally(() => { asking = null; });
      return asking;
    },
  };
}


/** a model list is tens of KB: far less than a page of messages */
const MODEL_REPLY_BYTES = 8 * 1024 * 1024;

/** The JSON body of `opencode api GET <path>` on the running service, in a folder emptied for the call; throws when no service runs, or it answers with an error or no JSON. */
export async function opencodeApiGet(options: OpencodeCliOptions, path: string): Promise<unknown> {
  const cli = opencodeCli({ maxReplyBytes: MODEL_REPLY_BYTES, ...options });
  if (!(await cli.serviceRunning())) throw new Error("no OpenCode service is running");
  return cli.get(path);
}
