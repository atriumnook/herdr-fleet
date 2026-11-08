import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TimedEvent } from "./events.ts";
import { metrics, readEvents, render } from "./metrics.ts";

const MIN = 60_000;
const P = "/repo";
const state = (t: number, run: string, role: string, agent: string, from: string | undefined, to: string, sent: boolean, extra: Partial<TimedEvent> = {}): TimedEvent =>
  ({ t: t * MIN, kind: "state", run, role, agent, group: run === "r" ? "g-lead" : run === "c" ? "g-project" : "g-lead", ...(run === "r" ? {} : { project: P }), interactive: role === "lead" || role === "coordinator", ...(from ? { from } : {}), to, sent, ...extra }) as TimedEvent;

/** a turn's end as the fleet read it: whether the run's result file held a HANDOFF */
const turnEnd = (t: number, run: string, role: string, agent: string, interactive: boolean, handoff: boolean): TimedEvent =>
  ({ t: t * MIN, kind: "turn", run, role, agent, group: "g-lead", ...(run === "r" ? {} : { project: P }), interactive, handoff }) as TimedEvent;

/** the role file a run started with, as the fleet recorded it */
const role = (t: number, run: string, name: string, source: "bundled" | "user", hash: string): TimedEvent =>
  ({ t: t * MIN, kind: "role", run, role: name, source, file: `/${source}/${name}.md`, hash, standing: "eeeeeeeeeeee" }) as TimedEvent;

// minutes from 0: the coordinator c, a thread's lead l, and its reviewer r (no project of its own: known by its group)
const events: TimedEvent[] = [
  state(0, "c", "coordinator", "claude", undefined, "starting", false),
  state(1, "c", "coordinator", "claude", "starting", "working", true),
  state(2, "l", "lead", "claude", undefined, "starting", false),
  state(3, "l", "lead", "claude", "starting", "working", true),
  state(4, "c", "coordinator", "claude", "working", "idle", true),
  state(5, "r", "reviewer", "agy", undefined, "starting", false),
  // an agy reviewer whose turn ended on a question the adapter did not know: no HANDOFF, its pane kept
  state(5.2, "r4", "reviewer", "agy", undefined, "starting", false),
  state(5.4, "r4", "reviewer", "agy", "starting", "working", true),
  state(5.8, "r4", "reviewer", "agy", "working", "done", true),
  turnEnd(5.8, "r4", "reviewer", "agy", false, false),
  state(6, "r", "reviewer", "agy", "starting", "idle", false, { error: "Agent started but is not ready for prompts; the task has not been sent." }),
  state(7, "r3", "reviewer", "agy", undefined, "starting", false),
  state(8, "r3", "reviewer", "agy", "starting", "failed", false, { error: "Unknown model x" }),
  // a claude reviewer whose pane closed before it wrote anything
  state(9, "r2", "reviewer", "claude", undefined, "starting", false, { group: "g-lead" } as Partial<TimedEvent>),
  state(9.5, "r2", "reviewer", "claude", "starting", "working", true, { group: "g-lead" } as Partial<TimedEvent>),
  state(9.9, "r2", "reviewer", "claude", "working", "stopped", false, { group: "g-lead" } as Partial<TimedEvent>),
  state(10, "l", "lead", "claude", "working", "idle", true),
  turnEnd(10, "l", "lead", "claude", true, true),
  // 10 to 40: nothing moves (30 minutes); then the lead resumes by itself
  state(40, "l", "lead", "claude", "idle", "working", false),
  state(45, "l", "lead", "claude", "working", "done", false),
  // the lead ends a turn to wait, with no HANDOFF yet: it talks in its pane, and has not ended
  turnEnd(45, "l", "lead", "claude", true, false),
  // 45 to 50: still, but shorter than the quiet period; the person writes, and types once more into the pane
  { t: 50 * MIN, kind: "person", run: "c", project: P },
  state(50, "c", "coordinator", "claude", "idle", "working", true),
  state(52, "c", "coordinator", "claude", "working", "idle", true),
  state(53, "c", "coordinator", "claude", "idle", "working", false),
  state(54, "c", "coordinator", "claude", "working", "idle", false),
  { t: 70 * MIN, kind: "standstill", run: "c", project: P, quietMs: 15 * MIN },
  { t: 71 * MIN, kind: "reconciled", run: "l", project: P, pr: 9 },
  // the fleet closes the landed thread: its lead's last turn left no HANDOFF, and it is not lost
  state(71, "l", "lead", "claude", "done", "stopped", false),
  // another project's run: never counted here
  state(20, "x", "lead", "codex", undefined, "starting", false, { project: "/other", group: "g-other" } as Partial<TimedEvent>),
  role(20, "x", "lead", "bundled", "bbbbbbbbbbbb"),
  // the role version each run started with; r started before the fleet recorded it
  role(0, "c", "coordinator", "bundled", "aaaaaaaaaaaa"),
  role(2, "l", "lead", "bundled", "bbbbbbbbbbbb"),
  role(5.2, "r4", "reviewer", "bundled", "cccccccccccc"),
  role(7, "r3", "reviewer", "bundled", "cccccccccccc"),
  // a user's reviewer.md in place of the bundled one
  role(9, "r2", "reviewer", "user", "dddddddddddd"),
];

const issues = [
  { number: 1, title: "phase work", createdAt: new Date(1 * MIN).toISOString(), closedAt: new Date(60 * MIN).toISOString(), labels: [{ name: "rust-migration" }, { name: "phase:1" }] },
  { number: 2, title: "found a bug", createdAt: new Date(30 * MIN).toISOString(), closedAt: null, labels: [{ name: "rust-migration" }] },
  { number: 3, title: "before the window", createdAt: new Date(-500 * MIN).toISOString(), closedAt: null, labels: [] },
];
const merged = [
  { number: 9, title: "the thread", mergedAt: new Date(44 * MIN).toISOString(), baseRefName: "rust" },
  { number: 8, title: "old", mergedAt: new Date(-100 * MIN).toISOString(), baseRefName: "rust" },
  { number: 7, title: "into another branch", mergedAt: new Date(44 * MIN).toISOString(), baseRefName: "main" },
];

describe("factory metrics", () => {
  const result = metrics({ events, project: P, base: "rust", from: 0, to: 80 * MIN, quietMs: 15 * MIN, merged, issues, planned: /^(phase:|tracking$)/ });

  it("counts the person stepping in: messages through the fleet and turns typed into the coordinator's pane", () => {
    expect(result.interventions).toEqual({ messages: 1, typedTurns: 1 });
  });

  it("finds the stretches with no run of the project moving that last the quiet period, up to the end of the window", () => {
    expect(result.standstills).toEqual([{ from: 10 * MIN, to: 40 * MIN }, { from: 54 * MIN, to: 80 * MIN }]);
  });

  it("counts runs per agent, the starts that failed or stopped before the task, the runs that ended or a helper's turn that settled without a HANDOFF, and calls an anomaly", () => {
    expect(result.starts).toEqual([
      { agent: "agy", starts: 3, failed: 2, lost: 1, anomaly: true },
      { agent: "claude", starts: 3, failed: 0, lost: 1, anomaly: false },
    ]);
  });

  it("counts runs per role version, the starts that failed and the runs without a HANDOFF, with the runs of no recorded version apart", () => {
    // by hand from the events above: r3 failed to start and r4 left no HANDOFF on reviewer@cccc,
    // r2 (the user's reviewer) stopped before writing one, r failed to start before versions were recorded
    expect(result.roles).toEqual([
      { role: "coordinator", hash: "aaaaaaaaaaaa", source: "bundled", file: "/bundled/coordinator.md", starts: 1, failed: 0, lost: 0 },
      { role: "lead", hash: "bbbbbbbbbbbb", source: "bundled", file: "/bundled/lead.md", starts: 1, failed: 0, lost: 0 },
      { role: "reviewer", hash: "cccccccccccc", source: "bundled", file: "/bundled/reviewer.md", starts: 2, failed: 1, lost: 1 },
      { role: "reviewer", hash: "dddddddddddd", source: "user", file: "/user/reviewer.md", starts: 1, failed: 0, lost: 1 },
      { role: "reviewer", starts: 1, failed: 1, lost: 0 },
    ]);
    const text = render(P, "rust", result);
    const table = text.slice(text.indexOf("## Runs per role version"), text.indexOf("## Output"));
    expect(table).toContain("| reviewer | cccccccccccc (bundled) | 2 | 1 | 1 |");
    expect(table).toContain("| reviewer | dddddddddddd (user) | 1 | 0 | 1 |");
    expect(table).toContain("| reviewer | not recorded | 1 | 1 | 0 |");
  });

  it("counts the turns an agent started by itself, per role, apart from the coordinator's typed ones", () => {
    expect(result.ownTurns).toEqual({ lead: 1 });
  });

  it("takes from GitHub what falls in the window and was merged into the base, and the issues opened without a phase label as found during the work", () => {
    expect(result.merged.map((pr) => pr.number)).toEqual([9]);
    expect(result.closed.map((issue) => issue.number)).toEqual([1]);
    expect(result.found.map((issue) => issue.number)).toEqual([2]);
    expect(result.reconciled).toBe(1);
    expect(result.standstillCalls).toBe(1);
  });

  it("lists every issue opened in the window when no planned label is given", () => {
    const all = metrics({ events, project: P, base: "rust", from: 0, to: 80 * MIN, quietMs: 15 * MIN, merged, issues });
    expect(all.found.map((issue) => issue.number)).toEqual([1, 2]);
    expect(render(P, "rust", all)).toContain("- Issues opened: 2");
    expect(render(P, "rust", result)).toContain("- Issues opened without a planned label (^(phase:|tracking$)): 1");
  });

  it("puts the anomalies first", () => {
    const text = render(P, "rust", result);
    const anomalies = text.slice(text.indexOf("## Anomalies"), text.indexOf("## Without the person"));
    expect(anomalies).toContain("The person stepped in 2 times.");
    expect(anomalies).toContain("Stood still 30 minutes");
    expect(anomalies).toContain("agy: of 3 runs, 2 failed or stopped before the task and 1 ended without a report.");
  });

  it("counts per agent the turns that ended without a report, and the lead runs the fleet restarted: started, not started, and later ready", () => {
    const reported = (t: number, run: string, role: string, agent: string, report: string): TimedEvent =>
      ({ ...turnEnd(t, run, role, agent, role === "lead", report !== "none"), report }) as TimedEvent;
    const log: TimedEvent[] = [
      state(0, "l1", "lead", "claude", undefined, "starting", false),
      state(1, "l1", "lead", "claude", "starting", "working", true),
      state(2, "l1", "lead", "claude", "working", "idle", true),
      reported(2, "l1", "lead", "claude", "none"),
      { t: 2 * MIN, kind: "restart", run: "l1", project: P, agent: "claude", why: "no-report", by: "l2", to: "codex" },
      state(2, "l2", "lead", "codex", undefined, "starting", false),
      state(3, "l2", "lead", "codex", "starting", "working", true),
      state(5, "l2", "lead", "codex", "working", "idle", true),
      reported(5, "l2", "lead", "codex", "ready"),
      // another thread, whose lead failed with no CLI left to restart it on
      state(6, "l3", "lead", "codex", undefined, "starting", false),
      state(6.5, "l3", "lead", "codex", "starting", "working", true),
      state(7, "l3", "lead", "codex", "working", "failed", true, { error: "quota" }),
      reported(7, "l3", "lead", "codex", "none"),
      { t: 7 * MIN, kind: "restart", run: "l3", project: P, agent: "codex", why: "failed", error: "No candidate is usable" },
      // a helper that reported, and a turn logged before reports were (it counts for neither)
      state(7.5, "r5", "reviewer", "claude", undefined, "starting", false),
      reported(8, "r5", "reviewer", "claude", "ready"),
      state(8.5, "r6", "reviewer", "claude", undefined, "starting", false),
      turnEnd(9, "r6", "reviewer", "claude", false, true),
    ];
    const counted = metrics({ events: log, project: P, base: "rust", from: 0, to: 10 * MIN, quietMs: 15 * MIN, merged: [], issues: [] });
    expect(counted.reports).toEqual([{ agent: "claude", turns: 2, none: 1 }, { agent: "codex", turns: 2, none: 1 }]);
    expect(counted.restarts).toEqual({ started: 1, failed: 1, ready: 1 });
    // l1's last turn left no report: a lead counts now that leads report, as l3 failed does
    expect(counted.starts).toEqual([
      { agent: "claude", starts: 3, failed: 0, lost: 1, anomaly: false },
      { agent: "codex", starts: 2, failed: 0, lost: 1, anomaly: false },
    ]);
    const text = render(P, "rust", counted);
    expect(text).toContain("- Lead runs the fleet restarted on another CLI: 1 (1 could not start); replacements that later reported ready: 1");
    expect(text).toContain("| Agent | Turns that ended | Without a report |");
    expect(text).toContain("| codex | 2 | 1 |");
  });

  it("reads the event log line by line, skipping a line that does not parse, and nothing from a missing file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fleet-metrics-")), "fleet-events.jsonl");
    expect(readEvents(file)).toEqual([]);
    writeFileSync(file, '{"t":1,"kind":"person","run":"c","project":"/repo"}\n{"t":2,"kind":"per\n\n{"t":3,"kind":"standstill","run":"c","project":"/repo","quietMs":5}\n');
    expect(readEvents(file).map((event) => event.t)).toEqual([1, 3]);
  });
});
