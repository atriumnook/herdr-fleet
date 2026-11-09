/**
 * The factory's metrics for one project, from the fleet's event log (events.ts) and what GitHub
 * says: how often the person stepped in, the stretches the project stood still, starts per agent
 * with the failed ones, the runs that ended without a report, and the anomalies, the same per role
 * version (the role file a run started with), the turns that ended without a report, the thread
 * lead runs the fleet started again, the turns agents started by themselves, the threads
 * closed against GitHub, the merges the gate made with how many were reverted and how fast
 * (merge-mode.ts), the pull requests merged into the project's base, the issues closed and
 * the issues opened (without a planned label, when one is given: found during the work). Pure:
 * `fleet report` (api.ts) and scripts/factory-report.ts read the inputs and hand them in.
 */
import { readFileSync } from "node:fs";
import type { TimedEvent } from "./events.ts";
import type { IssueSummary as IssueRow, MergedPullRequest as PullRequestRow } from "./github.ts";

/** The events in `file`, skipping a line that does not parse; none when the file is missing. */
export function readEvents(file: string): TimedEvent[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  return text.split("\n").filter((line) => line.trim()).flatMap((line) => { try { return [JSON.parse(line) as TimedEvent]; } catch { return []; } });
}


export interface FactoryMetrics {
  from: number;
  to: number;
  logStart?: number;
  interventions: { messages: number; typedTurns: number };
  standstills: Array<{ from: number; to: number }>;
  standstillCalls: number;
  /** per agent: runs started, starts that failed or stopped before the task, runs that ended without a report */
  starts: Array<{ agent: string; starts: number; failed: number; lost: number; anomaly: boolean }>;
  /** the same counts per role version: the role file a run started with and its hash, absent for a run whose version was not recorded */
  roles: Array<{ role: string; hash?: string; source?: string; file?: string; starts: number; failed: number; lost: number }>;
  /** per agent: the turns that ended since the fleet reads reports, and those that left none */
  reports: Array<{ agent: string; turns: number; none: number }>;
  /** the thread lead runs the fleet started again: started, could not start, and replacements that later reported ready */
  restarts: { started: number; failed: number; ready: number };
  ownTurns: Record<string, number>;
  reconciled: number;
  /**
   * the threads merged in the window, by who merged them (merge-mode.ts); of the gate's, those
   * reverted by the end of the window, and the time from each such merge to its revert (DORA's
   * change failure rate and time to restore, measured from the merge)
   */
  merges: { gate: number; person: number; github: number; reverted: number; restoreMs: number[] };
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
  const mine = events.filter((event) => (event.kind === "state" || event.kind === "turn" || event.kind === "role" ? runs.has(event.run) : event.project === project));
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

  // each count goes to the run's agent and to the role version it started with (a role event, when the fleet recorded one)
  type Counts = { starts: number; failed: number; lost: number };
  const versionOf = new Map<string, Extract<TimedEvent, { kind: "role" }>>();
  for (const event of mine) if (event.kind === "role") versionOf.set(event.run, event);
  const startsByAgent = new Map<string, Counts>();
  const startsByVersion = new Map<string, { role: string; version?: Extract<TimedEvent, { kind: "role" }> } & Counts>();
  const count = (event: Extract<TimedEvent, { kind: "state" }>, key: keyof Counts) => {
    const agent = startsByAgent.get(event.agent) ?? { starts: 0, failed: 0, lost: 0 };
    startsByAgent.set(event.agent, agent);
    agent[key] += 1;
    const version = versionOf.get(event.run);
    const versionKey = `${event.role}\0${version?.hash ?? ""}`;
    const row = startsByVersion.get(versionKey) ?? { role: event.role, ...(version ? { version } : {}), starts: 0, failed: 0, lost: 0 };
    startsByVersion.set(versionKey, row);
    row[key] += 1;
  };
  /** each run's last state change in the window, its open turn's end (cleared when it works again), and whether its start failed */
  const last = new Map<string, Extract<TimedEvent, { kind: "state" }>>();
  const turnEnd = new Map<string, Extract<TimedEvent, { kind: "turn" }>>();
  const startFailed = new Set<string>();
  const ownTurns: Record<string, number> = {};
  let typedTurns = 0;
  for (const event of inWindow) {
    if (event.kind === "turn") turnEnd.set(event.run, event);
    if (event.kind !== "state") continue;
    last.set(event.run, event);
    if (event.to === "working") turnEnd.delete(event.run);
    if (event.from === undefined) count(event, "starts");
    // a start that failed, or that stopped before its task was sent
    if (!startFailed.has(event.run) && ((event.to === "failed" && event.from === "starting") || (event.error !== undefined && /not been sent|not ready/.test(event.error)))) {
      startFailed.add(event.run);
      count(event, "failed");
    }
    if (event.to === "working" && event.from !== undefined && event.from !== "starting" && !event.sent) {
      if (event.role === "coordinator") typedTurns += 1;
      else ownTurns[event.role] = (ownTurns[event.role] ?? 0) + 1;
    }
  }
  // a run without a report, its start not counted already: one that failed, one whose last turn left
  // none (a helper's pane is kept; a lead's thread starts again), or a helper that ended in the middle
  // of one. A lead stopped mid-turn is not counted: the fleet closes a landed thread, the person stops
  // one. Events written before reports say only whether a HANDOFF was there, and a lead then ended
  // turns to wait without one.
  for (const event of last.values()) {
    if (event.role === "coordinator" || startFailed.has(event.run)) continue;
    const end = turnEnd.get(event.run);
    const interactive = event.interactive ?? end?.interactive ?? false;
    const unreported = end ? (end.report !== undefined ? end.report === "none" : !end.handoff) : event.to === "stopped";
    if (event.to === "failed" || ((!interactive || end?.report !== undefined) && unreported)) count(event, "lost");
  }
  const reportsByAgent = new Map<string, { turns: number; none: number }>();
  for (const event of inWindow) {
    if (event.kind !== "turn" || event.report === undefined) continue;
    const entry = reportsByAgent.get(event.agent) ?? { turns: 0, none: 0 };
    entry.turns += 1;
    if (event.report === "none") entry.none += 1;
    reportsByAgent.set(event.agent, entry);
  }
  const reports = [...reportsByAgent].map(([agent, counts]) => ({ agent, ...counts })).sort((a, b) => a.agent.localeCompare(b.agent));
  const restartEvents = inWindow.filter((event): event is Extract<TimedEvent, { kind: "restart" }> => event.kind === "restart");
  const replacements = new Set(restartEvents.flatMap((event) => (event.by ? [event.by] : [])));
  const readyAfter = new Set(inWindow.filter((event) => event.kind === "turn" && event.report === "ready" && replacements.has(event.run)).map((event) => event.run));
  const restarts = { started: replacements.size, failed: restartEvents.filter((event) => !event.by).length, ready: readyAfter.size };
  const starts = [...startsByAgent].map(([agent, { starts, failed, lost }]) => ({ agent, starts, failed, lost, anomaly: failed + lost >= 2 && (failed + lost) * 3 >= Math.max(starts, failed + lost) }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
  // per role, the recorded versions by hash, then the runs of no recorded version
  const roles = [...startsByVersion.values()].map(({ role, version, starts, failed, lost }) => ({ role, ...(version ? { hash: version.hash, source: version.source, file: version.file } : {}), starts, failed, lost }))
    .sort((a, b) => a.role.localeCompare(b.role) || (a.hash === undefined ? 1 : b.hash === undefined ? -1 : a.hash.localeCompare(b.hash)));

  const mergeEvents = inWindow.filter((event): event is Extract<TimedEvent, { kind: "merge" }> => event.kind === "merge");
  const gateMerges = new Map(mergeEvents.filter((event) => event.by === "gate" && event.commit).map((event) => [event.commit!, event.t]));
  const restoreMs = mine.filter((event): event is Extract<TimedEvent, { kind: "revert" }> => event.kind === "revert" && event.t <= to && gateMerges.has(event.commit))
    .map((event) => event.t - gateMerges.get(event.commit)!).filter((ms) => ms >= 0).sort((a, b) => a - b);
  const merges = {
    gate: mergeEvents.filter((event) => event.by === "gate").length,
    person: mergeEvents.filter((event) => event.by === "person").length,
    github: mergeEvents.filter((event) => event.by === "github").length,
    reverted: restoreMs.length,
    restoreMs,
  };

  const within = (at: string | null) => at !== null && Date.parse(at) >= from && Date.parse(at) <= to;
  return {
    from, to, ...(logStart !== undefined ? { logStart } : {}),
    interventions: { messages: inWindow.filter((event) => event.kind === "person").length, typedTurns },
    standstills,
    standstillCalls: inWindow.filter((event) => event.kind === "standstill").length,
    starts,
    roles,
    reports,
    restarts,
    ownTurns,
    reconciled: inWindow.filter((event) => event.kind === "reconciled").length,
    merges,
    merged: input.merged.filter((pr) => pr.baseRefName === input.base && within(pr.mergedAt)),
    closed: input.issues.filter((issue) => within(issue.closedAt)),
    ...(input.planned ? { planned: input.planned.source } : {}),
    found: input.issues.filter((issue) => within(issue.createdAt) && !issue.labels.some((label) => input.planned?.test(label.name))),
  };
}

const clock = (at: number) => new Date(at).toLocaleString("sv-SE").slice(0, 16);
const minutes = (ms: number) => Math.round(ms / 60_000);
const median = (sorted: number[]) => sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

export function render(project: string, base: string, metrics: FactoryMetrics): string {
  const anomalies = [
    ...(metrics.interventions.messages + metrics.interventions.typedTurns > 0 ? [`The person stepped in ${metrics.interventions.messages + metrics.interventions.typedTurns} times.`] : []),
    ...metrics.standstills.map((still) => `Stood still ${minutes(still.to - still.from)} minutes (${clock(still.from)} to ${clock(still.to)}).`),
    ...metrics.starts.filter((row) => row.anomaly).map((row) => `${row.agent}: of ${row.starts} runs, ${row.failed} failed or stopped before the task and ${row.lost} ended without a report.`),
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
    `- Lead runs the fleet restarted on another CLI: ${metrics.restarts.started} (${metrics.restarts.failed} could not start); replacements that later reported ready: ${metrics.restarts.ready}`,
    `- Turns an agent started by itself: ${Object.entries(metrics.ownTurns).map(([role, count]) => `${role} ${count}`).join(", ") || "none"}`,
    "",
    "## Starts per agent",
    "",
    "| Agent | Starts | Failed or stopped before the task | Ended without a report |",
    "|---|---|---|---|",
    ...(metrics.starts.length ? metrics.starts.map((row) => `| ${row.agent} | ${row.starts} | ${row.failed} | ${row.lost}${row.anomaly ? " (anomaly)" : ""} |`) : ["| none | 0 | 0 | 0 |"]),
    "",
    "## Runs per role version",
    "",
    "| Role | Version | Starts | Failed or stopped before the task | Ended without a report |",
    "|---|---|---|---|---|",
    ...(metrics.roles.length ? metrics.roles.map((row) => `| ${row.role} | ${row.hash ? `${row.hash} (${row.source})` : "not recorded"} | ${row.starts} | ${row.failed} | ${row.lost} |`) : ["| none | | 0 | 0 | 0 |"]),
    "",
    "## Reports",
    "",
    "| Agent | Turns that ended | Without a report |",
    "|---|---|---|",
    ...(metrics.reports.length ? metrics.reports.map((row) => `| ${row.agent} | ${row.turns} | ${row.none} |`) : ["| none | 0 | 0 |"]),
    "",
    "## Merges",
    "",
    `- Merged by the gate: ${metrics.merges.gate}; by the person: ${metrics.merges.person}; outside the fleet's steps on GitHub: ${metrics.merges.github}`,
    `- Gate merges reverted later: ${metrics.merges.reverted}${metrics.merges.gate ? ` (change failure rate ${Math.round((metrics.merges.reverted / metrics.merges.gate) * 100)}%)` : ""}`,
    `- Time to restore: ${metrics.merges.restoreMs.length ? `median ${minutes(median(metrics.merges.restoreMs))} minutes, longest ${minutes(metrics.merges.restoreMs.at(-1)!)} minutes (from the merge to its revert)` : "nothing reverted"}`,
    "",
    "## Output",
    "",
    `- Pull requests merged: ${metrics.merged.length}${metrics.merged.length ? ` (${metrics.merged.map((pr) => `#${pr.number}`).join(", ")})` : ""}`,
    `- Issues closed: ${metrics.closed.length}`,
    `- Issues opened${metrics.planned ? ` without a planned label (${metrics.planned})` : ""}: ${metrics.found.length}${metrics.found.length ? `: ${metrics.found.map((issue) => `#${issue.number} ${issue.title}`).join("; ")}` : ""}`,
    "",
  ].join("\n");
}
