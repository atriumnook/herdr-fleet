import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ReportState } from "../../shared/fleet.ts";

/**
 * What happened in the fleet, one JSON object per line, appended and never rewritten: the raw data
 * the factory's metrics are computed from (scripts/factory-report.ts). The run registry keeps each
 * run's last state only; this keeps every change, so how long a project stood still, how often the
 * person stepped in and how often an agent failed to start can be counted afterwards.
 *
 * No message text, handoff or screen goes in: only ids, roles, agents, models, states and times.
 */
export type FleetEvent =
  /**
   * a run's state changed (`from` is absent for a new run); `sent` says whether a turn the fleet sent
   * is open; `interactive`, whether the run talks in its pane (absent in events written before it was)
   */
  | { kind: "state"; run: string; role: string; agent: string; model?: string; group: string; project?: string; interactive?: boolean; from?: string; to: string; sent: boolean; error?: string }
  /**
   * a run's turn ended and the fleet read what it left: `handoff`, whether its result file holds a
   * HANDOFF; `report`, the state its report.json gave, or `none` without a valid one (absent for a
   * run that keeps no result folder, and in events written before reports); `interactive`, whether
   * the run talks in its pane
   */
  | { kind: "turn"; run: string; role: string; agent: string; model?: string; group: string; project?: string; interactive: boolean; handoff: boolean; report?: ReportState | "none" }
  /**
   * the role a run started with: its file, where that came from (bundled, the user's, the project's)
   * and the file's version (agents.ts roleVersion), and the version of the standing orders it was
   * given, absent when there were none; `fleet report` compares runs per role version
   */
  | { kind: "role"; run: string; role: string; source: "bundled" | "user" | "project"; file: string; hash: string; standing?: string }
  /** the person wrote to a project's coordinator through the fleet (`fleet project`, the Fleet screen) */
  | { kind: "person"; run: string; project: string }
  /** a project run without the person stood still and its coordinator was told (superviseProjects) */
  | { kind: "standstill"; run: string; project: string; quietMs: number }
  /** a thread the fleet closed because GitHub showed its pull request merged (superviseProjects) */
  | { kind: "reconciled"; run: string; project: string; pr?: number }
  /**
   * a thread's lead run failed, or ended a turn without a report, and the fleet started the thread
   * again: `by` the new run on CLI `to`, or `error` when none could start
   */
  | { kind: "restart"; run: string; project: string; agent: string; why: "failed" | "no-report"; by?: string; to?: string; error?: string };

export type TimedEvent = FleetEvent & { t: number };

/** Appends events to `file`, creating it private to the user. A failed write loses the event, never the fleet's work. */
export function eventLog(file: string): (event: FleetEvent) => void {
  let ready = false;
  return (event) => {
    try {
      if (!ready) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); ready = true; }
      appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...event })}\n`, { mode: 0o600 });
    } catch {
      // the metrics miss one event; the run itself goes on
    }
  };
}
