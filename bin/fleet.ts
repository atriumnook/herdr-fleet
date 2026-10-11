#!/usr/bin/env bun
/**
 * fleet: start agents in herdr panes and talk to them, through a running herdr-fleet server.
 * Agents the fleet starts get this command in their instructions, with the environment below set.
 *
 *   HERDR_FLEET_URL    the server (default http://127.0.0.1:7317)
 *   HERDR_FLEET_TOKEN  its access token, when it has one
 *   HERDR_FLEET_GROUP  the fleet to act in; else one per herdr pane (HERDR_PANE_ID)
 *   HERDR_FLEET_DEPTH  how deep this caller is (0 for a person or a top-level agent)
 *   HERDR_FLEET_RUN    the caller's own run, when the fleet started it: a thread it starts is its own
 */
import { parseArgs } from "node:util";

const USAGE = `usage: fleet <command> [options]

  spawn --role <role> --task <text> [--name <name>] [--model <provider/model>] [--thinking <level>]
        [--cwd <dir>] [--worktree] [--interactive] [--direction right|down] [--wait] [--timeout <ms>]
        [--avoid <cli>]...               keep a CLI out (pi, claude, codex, cursor, agy), such as the writer's for a review
        an agent handing work on gives a brief instead of --task (--task then adds notes):
        --goal <one sentence> --write <path>... | --read-only --context <files, earlier results, or none>
        --done <checkable condition> --verify <commands, and the evidence to return> [--forbid <text>] [--timebox <text>]
  thread --title <title> --task <text> [--cwd <dir>]
                                   start a thread: a lead in a workspace of its own, on a worktree of its own in a repository
                                   (an agent gives a brief instead of --task, as for spawn)
  threads [--cwd <dir>]            the threads of this project: state, branch, HANDOFF status line and contract
  project --task <text> [--cwd <dir>]
                                   talk to the project's coordinator, started at its main checkout if none runs
  guide                            how an agent in a pane's conversation hands work to the fleet (the fleet skill runs this)
  send <agent> <message...>        hand an agent its next task
  wait <agent> [--timeout <ms>]    until its turn settles; follows a re-spawn after a fallback
  read <agent> [--lines <n>]       its recent output
  list [--all]                     this fleet's agents (--all: every fleet)
  interrupt <agent>                press Esc in its pane
  focus <agent>                    bring its pane to front in herdr
  close-done                       close the panes of finished non-interactive agents
  roles [--cwd <dir>]              the roles that can be spawned
  usage [--refresh]                what each subscription has used, and which are cooling down
  usage clear [<key>]              end a cooldown: one account (agy:gemini), a CLI's (agy), or all

  <agent> is a name, role, id or pane id. Add --json for machine-readable output.
  exit status: 0 settled, 1 failed or error, 2 usage, 4 blocked on a question, 124 wait timed out`;

interface Run {
  id: string; name: string; role: string; agent: string; group: string; paneId: string; state: string;
  model?: string; lastOutput?: string; result?: string; lastError?: string; replacedBy?: string;
}

const env = process.env;
const baseUrl = (env["HERDR_FLEET_URL"] || "http://127.0.0.1:7317").replace(/\/$/, "");
const paneId = env["HERDR_PANE_ID"];
const group = env["HERDR_FLEET_GROUP"] || (paneId ? `fleet-${paneId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}` : "fleet-default");
const depth = Number.parseInt(env["HERDR_FLEET_DEPTH"] ?? "0", 10) || 0;
const callerRun = env["HERDR_FLEET_RUN"] || undefined;

/** What the fleet skill (server/fleet/entrances.ts) has an agent in a pane's conversation read; kept here so it matches this CLI. */
const GUIDE = `herdr-fleet runs a team of coding agents in herdr. Each repository has one coordinator: it talks with
the person on the Fleet screen and splits work into threads, each on a branch of its own.
Below, \`fleet\` is the command the skill named, with HERDR_FLEET_URL set as it shows.

To hand work on:  fleet project --cwd <the repository> --task "<the request>"
- This is a handoff: the repository's coordinator owns the work from here. Do not wait for it, and do not
  follow its threads up yourself.
- The coordinator has not seen this conversation. Write the request so that it stands alone: what to do and
  why, what this conversation found and decided, the files involved, and how to tell it is done.
- Then tell the person it was sent, and that the coordinator's reply and its threads are on the Fleet screen.

To check on it, when the person asks:  fleet threads --cwd <the repository>

If the command cannot reach the server, your sandbox may block the loopback: ask to run that one command
outside it. Do not change the sandbox's network settings.`;

class CliError extends Error {
  constructor(message: string, readonly exitCode = 1, readonly body?: { run?: Run }) { super(message); }
}

async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { "x-herdr-fleet": "1" };
  if (env["HERDR_FLEET_TOKEN"]) headers["authorization"] = `Bearer ${env["HERDR_FLEET_TOKEN"]}`;
  if (body) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/fleet${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch (error) {
    throw new CliError(`cannot reach the fleet server at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}. Start it with \`bun run start\` in herdr-fleet.`);
  }
  const data = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string }; run?: Run };
  if (!response.ok) {
    const code = data.error?.code ?? `http_${response.status}`;
    throw new CliError(`${code}: ${data.error?.message ?? response.statusText}`, code === "wait_timeout" ? 124 : 1, data);
  }
  return data as T;
}

interface ThreadSummary {
  run: Run & { branch?: string; pr?: { number: number; url: string; state: string; checks: string } };
  state: keyof typeof THREAD_STATES;
  status?: string;
  contract?: Array<{ id: string; state: "met" | "open" | "unmet" }>;
}

const CONTRACT_MARKS = { met: "✓", open: "·", unmet: "✗" } as const;
const THREAD_STATES = { working: "Working", waiting: "Needs you", review: "Ready for review", landing: "Landing", idle: "Idle", failed: "Failed", ended: "Ended", resolved: "Resolved" } as const;

function describeThread(thread: ThreadSummary): string {
  const contract = thread.contract?.length ? `Contract: ${thread.contract.map((item) => `${item.id} ${CONTRACT_MARKS[item.state]}`).join(" ")}` : "";
  return [
    `${thread.run.id}  ${thread.run.name}  ${THREAD_STATES[thread.state]}${thread.run.branch ? `  ${thread.run.branch}` : ""}`,
    thread.status ? `    ${thread.status}` : "",
    contract ? `    ${contract}` : "",
    thread.run.pr ? `    PR #${thread.run.pr.number} ${thread.run.pr.state.toLowerCase()}, checks ${thread.run.pr.checks}: ${thread.run.pr.url}` : "",
  ].filter(Boolean).join("\n");
}

interface UsageEntry {
  key: string; error?: string;
  reading?: { readAt: number; windows: Array<{ name: string; usedPercent: number; resetsAt?: number }> };
  cooldown?: { until: number; reason: string };
}

const enc = encodeURIComponent;
const time = (ms: number): string => new Date(ms).toLocaleString();

function describeUsage(entry: UsageEntry): string {
  const windows = entry.reading?.windows.map((w) => `${w.name} ${w.usedPercent}%${w.resetsAt ? ` (resets ${time(w.resetsAt)})` : ""}`).join(", ");
  return [
    `${entry.key.padEnd(12)} ${windows ?? "no reading"}${entry.reading ? `  read ${time(entry.reading.readAt)}` : ""}`,
    entry.cooldown && entry.cooldown.until > Date.now() ? `             cooling down until ${time(entry.cooldown.until)}: ${entry.cooldown.reason}` : "",
    entry.error ? `             last read failed: ${entry.error}` : "",
  ].filter(Boolean).join("\n");
}
interface BriefFlags {
  goal?: string; write?: string[]; "read-only"?: boolean; context?: string; done?: string; verify?: string; forbid?: string; timebox?: string;
}

/** The brief the flags give, or none when no brief flag is set; the server says which fields are missing, all at once. */
function briefOf(values: BriefFlags): Record<string, unknown> | undefined {
  const { goal, write, context, done, verify, forbid, timebox } = values;
  if ([goal, write, values["read-only"], context, done, verify, forbid, timebox].every((v) => v === undefined)) return undefined;
  if (write && values["read-only"]) throw new CliError("--write and --read-only do not go together", 2);
  return { goal, write: values["read-only"] ? [] : write, context, done, verify, forbidden: forbid, timebox };
}

const describe = (run: Run): string => `${run.id}  ${run.name} (${run.role}, ${run.agent}${run.model ? `, ${run.model}` : ""})  ${run.state}  pane ${run.paneId}`;

function print(json: boolean, value: unknown, text: () => string): void {
  console.log(json ? JSON.stringify(value, null, 2) : text());
}

function statusOf(run: Run): number {
  if (run.state === "blocked") return 4;
  if (run.state === "failed" || run.state === "stopped") return 1;
  return 0;
}

/** The handoff the agent wrote to its result file; without one, its screen. */
function resultText(run: Run): string {
  if (run.result) return `\n${run.result.trimEnd()}`;
  return run.lastOutput ? `\n${run.lastOutput.trimEnd()}` : "";
}

/** Waits for `target`; a run replaced after a failed first turn hands the wait to its replacement. */
async function waitFor(target: string, timeout: number | undefined, json: boolean): Promise<number> {
  let current = target;
  for (;;) {
    let run: Run;
    try {
      ({ run } = await call<{ run: Run }>("POST", `/runs/${enc(current)}/wait`, { group, ...(timeout ? { timeout_ms: timeout } : {}) }));
    } catch (error) {
      if (error instanceof CliError && error.exitCode === 124 && error.body?.run) {
        print(json, error.body.run, () => `${describe(error.body!.run!)}\nwait timed out; the agent is still ${error.body!.run!.state}`);
      }
      throw error;
    }
    if (run.replacedBy) {
      if (!json) console.error(`${run.name} failed on ${run.model ?? "its model"} (${run.lastError ?? "error"}); waiting for its re-spawn ${run.replacedBy}`);
      current = run.replacedBy;
      continue;
    }
    print(json, run, () => [describe(run), run.lastError ? `error: ${run.lastError}` : "", resultText(run)].filter(Boolean).join("\n"));
    return statusOf(run);
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") { console.log(USAGE); return command ? 0 : 2; }
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true, strict: true,
    options: {
      role: { type: "string" }, task: { type: "string" }, name: { type: "string" }, model: { type: "string" }, thinking: { type: "string" },
      cwd: { type: "string" }, worktree: { type: "boolean" }, interactive: { type: "boolean" }, direction: { type: "string" },
      wait: { type: "boolean" }, timeout: { type: "string" }, lines: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" },
      refresh: { type: "boolean" }, avoid: { type: "string", multiple: true },
      title: { type: "string" }, goal: { type: "string" }, write: { type: "string", multiple: true }, "read-only": { type: "boolean" }, context: { type: "string" },
      done: { type: "string" }, verify: { type: "string" }, forbid: { type: "string" }, timebox: { type: "string" },
    },
  });
  const json = values.json ?? false;
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 1)) throw new CliError("--timeout must be a positive number of milliseconds", 2);
  const target = (): string => {
    const value = positionals[0];
    if (!value) throw new CliError(`fleet ${command}: name the agent`, 2);
    return value;
  };

  switch (command) {
    case "spawn": {
      const brief = briefOf(values);
      if (!values.role || (!values.task && !brief)) throw new CliError("fleet spawn: --role and --task (or a brief) are required", 2);
      const { run } = await call<{ run: Run }>("POST", "/spawn", {
        role: values.role, task: values.task, brief, name: values.name, model: values.model, thinking: values.thinking,
        cwd: values.cwd ?? process.cwd(), worktree: values.worktree, interactive: values.interactive, direction: values.direction,
        group, depth, caller_pane_id: paneId, avoid: values.avoid,
      });
      if (values.wait) return waitFor(run.id, timeout, json);
      print(json, run, () => [describe(run), run.lastError ? `note: ${run.lastError}` : ""].filter(Boolean).join("\n"));
      return run.state === "blocked" ? 4 : 0;
    }
    case "thread": {
      const brief = briefOf(values);
      if (!values.title || (!values.task && !brief)) throw new CliError("fleet thread: --title and --task (or a brief) are required", 2);
      const { run } = await call<{ run: Run }>("POST", "/threads", { title: values.title, task: values.task, brief, cwd: values.cwd ?? process.cwd(), depth, caller_run: callerRun });
      print(json, run, () => [describe(run), run.lastError ? `note: ${run.lastError}` : ""].filter(Boolean).join("\n"));
      return run.state === "blocked" ? 4 : 0;
    }
    case "threads": {
      const { threads } = await call<{ threads: ThreadSummary[] }>("GET", `/threads?cwd=${enc(values.cwd ?? process.cwd())}${callerRun ? `&caller_run=${enc(callerRun)}` : ""}`);
      print(json, threads, () => threads.length ? threads.map(describeThread).join("\n") : "no threads");
      return 0;
    }
    case "project": {
      if (!values.task) throw new CliError("fleet project: --task is required", 2);
      // an agent the fleet started reports to whoever started it (its instructions), never past it to the coordinator
      if (callerRun) throw new CliError("fleet project: the fleet's own agents do not call the coordinator; report as your instructions say", 2);
      const { run } = await call<{ run: Run }>("POST", "/projects", { task: values.task, cwd: values.cwd ?? process.cwd(), ...(paneId ? { from_pane: paneId } : {}) });
      print(json, run, () => [describe(run), run.lastError ? `note: ${run.lastError}` : ""].filter(Boolean).join("\n"));
      return run.state === "blocked" ? 4 : 0;
    }
    case "guide":
      console.log(GUIDE);
      return 0;
    case "send": {
      const message = positionals.slice(1).join(" ");
      if (!message) throw new CliError("fleet send: give the message", 2);
      const { run } = await call<{ run: Run }>("POST", `/runs/${enc(target())}/send`, { message, group });
      print(json, run, () => describe(run));
      return run.state === "failed" ? 1 : run.state === "blocked" ? 4 : 0;
    }
    case "wait":
      return waitFor(target(), timeout, json);
    case "read": {
      const { text } = await call<{ text: string }>("GET", `/runs/${enc(target())}/read?group=${enc(group)}${values.lines ? `&lines=${enc(values.lines)}` : ""}`);
      print(json, { text }, () => text.trimEnd());
      return 0;
    }
    case "list": {
      const { runs } = await call<{ runs: Run[] }>("GET", values.all ? "/runs" : `/runs?group=${enc(group)}`);
      print(json, runs, () => runs.length ? runs.map((run) => `${describe(run)}${values.all ? `  [${run.group}]` : ""}`).join("\n") : "no agents");
      return 0;
    }
    case "interrupt":
    case "focus": {
      const { run } = await call<{ run: Run }>("POST", `/runs/${enc(target())}/${command}`, { group });
      print(json, run, () => describe(run));
      return 0;
    }
    case "close-done": {
      const { runs } = await call<{ runs: Run[] }>("POST", "/close-done", { group });
      print(json, runs, () => runs.length ? runs.map((run) => `closed ${describe(run)}`).join("\n") : "nothing to close");
      return 0;
    }
    case "roles": {
      const { roles } = await call<{ roles: Array<{ name: string; description: string; agent: string; source: string }> }>("GET", `/roles?cwd=${enc(values.cwd ?? process.cwd())}`);
      print(json, roles, () => roles.map((role) => `${role.name.padEnd(12)} ${role.agent.padEnd(6)} ${role.description}`).join("\n"));
      return 0;
    }
    case "usage": {
      if (positionals[0] === "clear") {
        const { cleared } = await call<{ cleared: string[] }>("POST", "/usage/clear", positionals[1] ? { key: positionals[1] } : {});
        print(json, cleared, () => cleared.length ? `cleared ${cleared.join(", ")}` : "nothing was cooling down");
        return 0;
      }
      if (positionals.length) throw new CliError("fleet usage: the only subcommand is clear", 2);
      const { usage } = await call<{ usage: UsageEntry[] }>("POST", "/usage/refresh", { all: values.refresh ?? false });
      print(json, usage, () => usage.length ? usage.map(describeUsage).join("\n") : "no usage known yet");
      return 0;
    }
    default:
      throw new CliError(`unknown command: ${command}\n\n${USAGE}`, 2);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliError) {
    if (error.exitCode !== 124) console.error(`fleet: ${error.message}`);
    process.exitCode = error.exitCode;
  } else if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
    console.error(`fleet: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`fleet: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
