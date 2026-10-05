import type { AgentRun, AgentState, FleetAgentKind, SkippedCandidate, ThinkingLevel, UsageEntry, UsageWindow } from "../../shared/fleet.ts";
import { isEnded, type UiState } from "./state.ts";

/** The regions the Fleet screen draws: its Presenter re-renders when one of them changes. */
export const FLEET_REGIONS = ["runs", "usage", "request", "detail", "canAct"] as const;
export type FleetState = Pick<UiState, (typeof FLEET_REGIONS)[number]>;

/**
 * What the Fleet screen draws, built from the Mediator's state: the views take these values and
 * nothing else. Runs are ordered by what they ask of the person: waiting on them first, then
 * failed, working, done; ended runs fold away at the end.
 */

export type RunTone = "needs" | "failed" | "working" | "done" | "ended";

export interface RunCardModel {
  id: string;
  name: string;
  role: string;
  agent: FleetAgentKind;
  model?: string;
  thinking?: ThinkingLevel;
  group: string;
  depth: number;
  state: AgentState;
  tone: RunTone;
  startedAt: number;
  updatedAt: number;
  /** what a blocked run asks, as far as the fleet could read it */
  question?: string;
  /** why a failed run failed */
  error?: string;
  fallbackFrom?: string;
  replacedBy?: { id: string; name: string };
  skipped: SkippedCandidate[];
  result?: string;
  canOpenPane: boolean;
  canInterrupt: boolean;
  /** an action on this run is in flight */
  busy: boolean;
}

export interface UsageCapsuleModel {
  key: string;
  agent?: FleetAgentKind;
  /** the window closest to running out, while it has not reset */
  worst?: UsageWindow;
  level: "ok" | "mid" | "low";
  windows: UsageWindow[];
  cooldown?: { until: number; reason: string };
  /** the cooldown can be ended from here */
  canClear: boolean;
  readAt?: number;
  error?: string;
  busy: boolean;
}

export interface FleetScreenModel {
  status: "loading" | "ready" | "error";
  error?: string;
  counts: Record<Exclude<RunTone, "ended">, number>;
  sections: Array<{ tone: Exclude<RunTone, "ended">; runs: RunCardModel[] }>;
  ended: RunCardModel[];
  /** groups with finished non-interactive runs whose panes can be closed */
  closableGroups: string[];
  usage: { capsules: UsageCapsuleModel[]; refreshing: boolean; error?: string };
  detail?: RunCardModel;
  /** the last action failed: what to tell the person */
  requestError?: string;
  busy: boolean;
  /** this device may change things: a watch-only one gets no buttons that would be refused */
  canAct: boolean;
}

const KINDS: readonly FleetAgentKind[] = ["pi", "claude", "codex", "cursor", "agy"];

export function toneOf(state: AgentState): RunTone {
  switch (state) {
    case "blocked": return "needs";
    case "failed": return "failed";
    case "idle":
    case "done": return "done";
    case "stopped": return "ended";
    default: return "working";
  }
}

/** Plenty while half is left, getting low under half, low under a fifth (DESIGN.md meters). */
export function meterLevel(usedPercent: number): UsageCapsuleModel["level"] {
  return usedPercent < 50 ? "ok" : usedPercent < 80 ? "mid" : "low";
}

function card(run: AgentRun, runs: AgentRun[], state: FleetState): RunCardModel {
  const tone = toneOf(run.state);
  const pending = state.request.status === "pending" ? state.request.action : undefined;
  const replacement = run.replacedBy ? runs.find((other) => other.id === run.replacedBy) : undefined;
  return {
    id: run.id, name: run.name, role: run.role, agent: run.agent, model: run.model, thinking: run.thinking, group: run.group, depth: run.depth,
    state: run.state, tone, startedAt: run.startedAt, updatedAt: run.updatedAt,
    question: tone === "needs" ? run.lastError : undefined,
    error: tone === "failed" ? run.lastError : undefined,
    fallbackFrom: run.fallbackFrom,
    replacedBy: run.replacedBy ? { id: run.replacedBy, name: replacement?.name ?? run.replacedBy } : undefined,
    skipped: run.skipped ?? [],
    result: run.result,
    canOpenPane: !isEnded(run),
    canInterrupt: state.canAct && (tone === "working" || tone === "needs"),
    busy: pending?.kind === "interrupt" && pending.runId === run.id,
  };
}

function capsule(entry: UsageEntry, state: FleetState, now: number): UsageCapsuleModel {
  const windows = (entry.reading?.windows ?? []).filter((window) => window.resetsAt === undefined || window.resetsAt > now);
  const worst = windows.reduce<UsageWindow | undefined>((top, window) => (!top || window.usedPercent > top.usedPercent ? window : top), undefined);
  const prefix = entry.key.split(":")[0] as FleetAgentKind;
  const pending = state.request.status === "pending" ? state.request.action : undefined;
  return {
    key: entry.key,
    agent: KINDS.includes(prefix) ? prefix : undefined,
    worst,
    level: worst ? meterLevel(worst.usedPercent) : "ok",
    windows,
    cooldown: entry.cooldown && entry.cooldown.until > now ? { until: entry.cooldown.until, reason: entry.cooldown.reason } : undefined,
    canClear: state.canAct,
    readAt: entry.reading?.readAt,
    error: entry.error,
    busy: pending?.kind === "clear-cooldown" && pending.key === entry.key,
  };
}

export function fleetScreenModel(state: FleetState, now: number): FleetScreenModel {
  const runs = state.runs.data;
  const cards = runs.map((run) => card(run, runs, state));
  const byNewest = (a: RunCardModel, b: RunCardModel) => b.updatedAt - a.updatedAt;
  // working runs read as a tree: each group together, shallower first, in the order they started
  const byTree = (a: RunCardModel, b: RunCardModel) => a.group.localeCompare(b.group) || a.startedAt - b.startedAt;
  const of = (tone: RunTone) => cards.filter((run) => run.tone === tone);
  const sections = ([
    { tone: "needs", runs: of("needs").sort(byNewest) },
    { tone: "failed", runs: of("failed").sort(byNewest) },
    { tone: "working", runs: of("working").sort(byTree) },
    { tone: "done", runs: of("done").sort(byNewest) },
  ] as const).filter((section) => section.runs.length > 0).map((section) => ({ tone: section.tone, runs: [...section.runs] }));
  const closableGroups = !state.canAct ? [] : [...new Set(runs.filter((run) => !run.interactive && run.state === "done").map((run) => run.group))].sort();
  const detailRun = state.detail ? cards.find((run) => run.id === state.detail) : undefined;
  return {
    status: state.runs.status === "error" ? "error" : state.runs.status === "ready" ? "ready" : "loading",
    error: state.runs.error,
    counts: { needs: of("needs").length, failed: of("failed").length, working: of("working").length, done: of("done").length },
    sections,
    ended: of("ended").sort(byNewest),
    closableGroups,
    usage: {
      capsules: [...state.usage.data].sort((a, b) => a.key.localeCompare(b.key)).map((entry) => capsule(entry, state, now)),
      refreshing: state.usage.refreshing,
      error: state.usage.error,
    },
    detail: detailRun,
    requestError: state.request.status === "failed" ? state.request.message : undefined,
    busy: state.request.status === "pending",
    canAct: state.canAct,
  };
}

/** How many runs wait on the person: the count the Fleet button carries. */
export function needsCount(state: Pick<UiState, "runs">): number {
  return state.runs.data.filter((run) => run.state === "blocked").length;
}
