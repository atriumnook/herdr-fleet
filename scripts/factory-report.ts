/**
 * The factory's metrics for one project, as a report: what the fleet's event log (server/fleet/events.ts) and
 * GitHub say about a stretch of time, in Markdown, anomalies first. Reads only.
 *
 *   bun scripts/factory-report.ts [--project <repo>] [--base <branch>] [--hours 24] [--events <file>] [--quiet-minutes 15] [--planned-label <regex>]
 *
 * --project defaults to the git root of the working folder, --base to the branch checked out there
 * (the threads' base: pull requests merged elsewhere are not this project's), --events to
 * fleet-events.jsonl in the fleet's state folder. GitHub is read with `gh` in the project folder. What it counts:
 * - the person stepping in: messages through the fleet (`fleet project`, the Fleet screen) and turns
 *   of the coordinator the fleet did not send (typed into its pane);
 * - standstills: stretches with no run of the project working, at least the quiet period long;
 * - starts per agent and how many failed or stopped at a question, and the agents where that is
 *   an anomaly (two or more, and a third or more of the starts);
 * - turns an agent started by itself (not sent by the fleet), per role;
 * - threads closed against GitHub, pull requests merged into the base, issues closed, and the issues
 *   opened (with --planned-label <regex>, those without a planned label: found during the work, each
 *   a defect to trace to the change that let it in).
 * The event log starts when the fleet first wrote it: earlier time is not counted.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { TimedEvent } from "../server/fleet/events.ts";
import { defaultStateDir } from "../server/state-dir.ts";

export interface PullRequestRow { number: number; title: string; mergedAt: string; baseRefName: string }
export interface IssueRow { number: number; title: string; createdAt: string; closedAt: string | null; labels: { name: string }[] }

export interface FactoryMetrics {
  from: number;
  to: number;
  logStart?: number;
  interventions: { messages: number; typedTurns: number };
  standstills: Array<{ from: number; to: number }>;
  standstillCalls: number;
  starts: Array<{ agent: string; starts: number; failed: number; anomaly: boolean }>;
  ownTurns: Record<string, number>;
  reconciled: number;
  merged: PullRequestRow[];
  closed: IssueRow[];
  found: IssueRow[];
  /** the labels of planned issues, as given (--planned-label) */
  planned?: string;
}

const MOVING = new Set(["working", "starting"]);

/** The runs of `project` in the events: its coordinator and threads, and the helpers in their groups. */
function projectRuns(events: TimedEvent[], project: string): Set<string> {
  const groups = new Set<string>();
  for (const event of events) if (event.kind === "state" && event.project === project) groups.add(event.group);
  const runs = new Set<string>();
  for (const event of events) if (event.kind === "state" && (event.project === project || groups.has(event.group))) runs.add(event.run);
  return runs;
}

export function metrics(input: { events: TimedEvent[]; project: string; base: string; from: number; to: number; quietMs: number; merged: PullRequestRow[]; issues: IssueRow[]; planned?: RegExp }): FactoryMetrics {
  const { project, from, to, quietMs } = input;
  const events = [...input.events].sort((a, b) => a.t - b.t);
  const runs = projectRuns(events, project);
  const mine = events.filter((event) => (event.kind === "state" ? runs.has(event.run) : event.project === project));
  const inWindow = mine.filter((event) => event.t >= from && event.t <= to);

  // standstills: replay every state change, the ones before the window included, and find the stretches with no run moving
  const states = new Map<string, string>();
  const standstills: FactoryMetrics["standstills"] = [];
  const logStart = mine[0]?.t;
  let stillSince: number | undefined = logStart !== undefined ? Math.max(logStart, from) : undefined;
  const close = (at: number) => {
    if (stillSince !== undefined && at - stillSince >= quietMs) standstills.push({ from: stillSince, to: at });
  };
  for (const event of mine) {
    if (event.kind !== "state" || event.t > to) continue;
    const wasMoving = [...states.values()].some((state) => MOVING.has(state));
    states.set(event.run, event.to);
    const moving = [...states.values()].some((state) => MOVING.has(state));
    if (event.t < from) { stillSince = moving ? undefined : from; continue; }
    if (!wasMoving && moving) { close(event.t); stillSince = undefined; }
    else if (wasMoving && !moving) stillSince = event.t;
  }
  close(to);

  const startsByAgent = new Map<string, { starts: number; failed: number }>();
  const ownTurns: Record<string, number> = {};
  let typedTurns = 0;
  for (const event of inWindow) {
    if (event.kind !== "state") continue;
    if (event.from === undefined) {
      const entry = startsByAgent.get(event.agent) ?? { starts: 0, failed: 0 };
      entry.starts += 1;
      startsByAgent.set(event.agent, entry);
    }
    // a start that failed, or that stopped before its task was sent
    if ((event.to === "failed" && event.from === "starting") || (event.error !== undefined && /not been sent|not ready/.test(event.error))) {
      const entry = startsByAgent.get(event.agent) ?? { starts: 0, failed: 0 };
      entry.failed += 1;
      startsByAgent.set(event.agent, entry);
    }
    if (event.to === "working" && event.from !== undefined && event.from !== "starting" && !event.sent) {
      if (event.role === "coordinator") typedTurns += 1;
      else ownTurns[event.role] = (ownTurns[event.role] ?? 0) + 1;
    }
  }
  const starts = [...startsByAgent].map(([agent, { starts, failed }]) => ({ agent, starts, failed, anomaly: failed >= 2 && failed * 3 >= Math.max(starts, failed) }))
    .sort((a, b) => a.agent.localeCompare(b.agent));

  const within = (at: string | null) => at !== null && Date.parse(at) >= from && Date.parse(at) <= to;
  return {
    from, to, ...(logStart !== undefined ? { logStart } : {}),
    interventions: { messages: inWindow.filter((event) => event.kind === "person").length, typedTurns },
    standstills,
    standstillCalls: inWindow.filter((event) => event.kind === "standstill").length,
    starts,
    ownTurns,
    reconciled: inWindow.filter((event) => event.kind === "reconciled").length,
    merged: input.merged.filter((pr) => pr.baseRefName === input.base && within(pr.mergedAt)),
    closed: input.issues.filter((issue) => within(issue.closedAt)),
    ...(input.planned ? { planned: input.planned.source } : {}),
    found: input.issues.filter((issue) => within(issue.createdAt) && !issue.labels.some((label) => input.planned?.test(label.name))),
  };
}

const clock = (at: number) => new Date(at).toLocaleString("sv-SE").slice(0, 16);
const minutes = (ms: number) => Math.round(ms / 60_000);

export function render(project: string, base: string, metrics: FactoryMetrics): string {
  const anomalies = [
    ...(metrics.interventions.messages + metrics.interventions.typedTurns > 0 ? [`The person stepped in ${metrics.interventions.messages + metrics.interventions.typedTurns} times.`] : []),
    ...metrics.standstills.map((still) => `Stood still ${minutes(still.to - still.from)} minutes (${clock(still.from)} to ${clock(still.to)}).`),
    ...metrics.starts.filter((row) => row.anomaly).map((row) => `${row.agent}: ${row.failed} of ${row.starts} starts failed or stopped before the task.`),
  ];
  const standstillTotal = metrics.standstills.reduce((sum, still) => sum + (still.to - still.from), 0);
  return [
    `# Factory metrics: ${project} (${base})`,
    "",
    `${clock(metrics.from)} to ${clock(metrics.to)}${metrics.logStart !== undefined && metrics.logStart > metrics.from ? ` (the event log starts ${clock(metrics.logStart)})` : metrics.logStart === undefined ? " (no events for this project)" : ""}`,
    "",
    "## Anomalies",
    "",
    ...(anomalies.length ? anomalies.map((line) => `- ${line}`) : ["- None."]),
    "",
    "## Without the person",
    "",
    `- The person stepped in: ${metrics.interventions.messages} messages through the fleet, ${metrics.interventions.typedTurns} turns typed into the coordinator's pane`,
    `- Stood still: ${metrics.standstills.length} times, ${minutes(standstillTotal)} minutes in all; the coordinator was called ${metrics.standstillCalls} times`,
    `- Threads closed against GitHub: ${metrics.reconciled}`,
    `- Turns an agent started by itself: ${Object.entries(metrics.ownTurns).map(([role, count]) => `${role} ${count}`).join(", ") || "none"}`,
    "",
    "## Starts per agent",
    "",
    "| Agent | Starts | Failed or stopped before the task |",
    "|---|---|---|",
    ...(metrics.starts.length ? metrics.starts.map((row) => `| ${row.agent} | ${row.starts} | ${row.failed}${row.anomaly ? " (anomaly)" : ""} |`) : ["| none | 0 | 0 |"]),
    "",
    "## Output",
    "",
    `- Pull requests merged: ${metrics.merged.length}${metrics.merged.length ? ` (${metrics.merged.map((pr) => `#${pr.number}`).join(", ")})` : ""}`,
    `- Issues closed: ${metrics.closed.length}`,
    `- Issues opened${metrics.planned ? ` without a planned label (${metrics.planned})` : ""}: ${metrics.found.length}${metrics.found.length ? `: ${metrics.found.map((issue) => `#${issue.number} ${issue.title}`).join("; ")}` : ""}`,
    "",
  ].join("\n");
}

function gh<T>(project: string, args: string[]): T {
  const run = Bun.spawnSync(["gh", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`gh ${args.join(" ")}: ${run.stderr.toString().trim()}`);
  return JSON.parse(run.stdout.toString()) as T;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { project: { type: "string" }, base: { type: "string" }, "planned-label": { type: "string" }, hours: { type: "string" }, events: { type: "string" }, "quiet-minutes": { type: "string" } } });
  const root = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"], { stdout: "pipe" }).stdout.toString().trim();
  const project = values.project ?? root;
  if (!project) throw new Error("--project is required outside a git repository");
  const base = values.base ?? Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-C", project, "branch", "--show-current"], { stdout: "pipe" }).stdout.toString().trim();
  const to = Date.now();
  const from = to - Number(values.hours ?? 24) * 3_600_000;
  const file = values.events ?? join(defaultStateDir(), "fleet-events.jsonl");
  const events = existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).flatMap((line) => { try { return [JSON.parse(line) as TimedEvent]; } catch { return []; } })
    : [];
  const merged = gh<PullRequestRow[]>(project, ["pr", "list", "--state", "merged", "--limit", "200", "--json", "number,title,mergedAt,baseRefName"]);
  const issues = gh<IssueRow[]>(project, ["issue", "list", "--state", "all", "--limit", "500", "--json", "number,title,createdAt,closedAt,labels"]);
  console.log(render(project, base, metrics({ events, project, base, from, to, quietMs: Number(values["quiet-minutes"] ?? 15) * 60_000, merged, issues, ...(values["planned-label"] ? { planned: new RegExp(values["planned-label"]) } : {}) })));
}
