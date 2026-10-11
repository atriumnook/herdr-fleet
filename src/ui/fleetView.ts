import { handoffStatus, threadState, type AgentRun, type AgentState, type ContractItem, type DiffStat, type FleetAgentKind, type LandAction, type LineComment, type PullRequest, type SkippedCandidate, type ThinkingLevel, type ThreadState, type UsageEntry, type UsageWindow } from "../../shared/fleet.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { parseDiff, type DiffLine } from "./diff.ts";
import { isEnded, type ConfirmedStep, type ThreadTab, type UiState } from "./state.ts";

/** The regions the Fleet screen draws: its Presenter re-renders when one of them changes. */
export const FLEET_REGIONS = ["runs", "usage", "request", "canAct", "fleetView", "landing"] as const;
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

/** A project in the list: a repository the fleet's coordinators and threads work for, or a folder picked for a new one. */
export interface ProjectModel {
  path: string;
  name: string;
  /** what its threads ask of the person: one waits on them, one works, none does, or nothing has run there */
  dot: "needs" | "working" | "idle" | "none";
  selected: boolean;
}

/** The Overview's groups, by what the person has to do: answer, review, merge, wait, nothing. */
export type ThreadGroupKey = "needs" | "review" | "landing" | "working" | "idle";

export interface ThreadRowModel {
  id: string;
  title: string;
  state: ThreadState;
  group: ThreadGroupKey | "resolved";
  /** the badge's word and look */
  label: string;
  badge: Badge;
  agent: FleetAgentKind;
  branch?: string;
  diff?: DiffStat;
  contract: ContractItem[];
  pr?: PullRequest;
  /** what it waits on the person for: its question, the prompt on its screen, why it failed, or a landing step that went wrong */
  question?: string;
  startedAt: number;
  updatedAt: number;
  selected: boolean;
}

/** A thread's lead (runId null) or one of its helpers, to switch the chat beside to. */
export interface ThreadMemberModel {
  runId: string | null;
  name: string;
  agent: FleetAgentKind;
  badge: Badge;
  label: string;
  selected: boolean;
}

/** The thread or agent open in the Overview: the run whose pane the chat beside shows. */
export interface OpenRunModel {
  kind: "thread" | "agent";
  runId: string;
  title: string;
  label: string;
  badge: Badge;
  /** the pane shown: the lead's, the chosen helper's, or the agent's */
  paneId: string;
  paneRunId: string;
  agent: FleetAgentKind;
  ended: boolean;
  meta: string;
  branch?: string;
  diff?: DiffStat;
  contract: ContractItem[];
  members: ThreadMemberModel[];
  /** the candidates passed over before the shown run started, and why */
  skipped: SkippedCandidate[];
  canResolve: boolean;
  /** resolved, and can be opened again */
  resolved: boolean;
  /** a thread on a branch of its own: landing it */
  landing: LandingModel | null;
}

/** One line of a thread's change, with the person's comments on it (`index`: where each is kept, to take it back). */
export interface DiffLineModel extends DiffLine {
  comments: Array<{ index: number; text: string }>;
}

export interface DiffFileModel {
  path: string;
  from?: string;
  added: number;
  removed: number;
  binary: boolean;
  /** the person's comments on it not sent yet */
  comments: number;
  lines: DiffLineModel[];
}

/** How a check reads: met, worth a look, in the way, under way, or not there yet. */
export type CheckTone = "ok" | "warn" | "bad" | "run" | "none";

/** One check before a thread lands: what it is about, how it reads, and the step that settles it, if any. */
export type CheckModel = { tone: CheckTone } & (
  | { kind: "committed"; uncommitted: string[]; ahead: number }
  | { kind: "base"; baseBranch: string; behind: number; action?: "update" }
  | { kind: "contract"; items: ContractItem[] }
  | { kind: "review"; reviewers: Array<{ agent: FleetAgentKind; status?: string }> }
  | { kind: "comments"; count: number; action?: "comments" }
  | { kind: "pr"; pr?: PullRequest; error?: string }
  | { kind: "ci"; pr: PullRequest; action?: "fix-ci" }
);

/**
 * Landing a thread, as the open thread draws it: where it stands, the step under way or the one
 * that went wrong, the buttons it offers, its change with the person's comments, its checks, and
 * the step that waits for the person's yes.
 */
export interface LandingModel {
  runId: string;
  branch: string;
  baseBranch: string;
  /** the main checkout the thread lands in */
  repo: string;
  tab: ThreadTab;
  stage: "review" | "landing" | "landed";
  landed?: "merged" | "discarded";
  /** the step under way, until it went as asked */
  pending?: LandAction;
  /** what the fleet found when the last step did not go as asked */
  error?: string;
  pr?: PullRequest;
  /** the steps it offers */
  offers: { createPr: boolean; mergeLocal: boolean; discard: boolean; fixCi: boolean; mergePr: boolean };
  /**
   * What can be pressed now, on a device that may act with no action in flight and no step under
   * way: the lead's steps once its turn ended, a merge while it does not work, a discard always.
   */
  can: { lead: boolean; merge: boolean; discard: boolean };
  /** Merge PR waits for the checks to pass */
  mergePrReady: boolean;
  comments: LineComment[];
  changes: { status: "idle" | "loading" | "ready" | "error"; error?: string; truncated: boolean; files: DiffFileModel[] };
  checks: { status: "idle" | "loading" | "ready" | "error"; error?: string; branch: CheckModel[]; thread: CheckModel[]; pr: CheckModel[] };
  /** the Checks tab asks for a look: comments not sent, failing checks, a step that went wrong */
  attention: boolean;
  confirm: { action: ConfirmedStep; running: boolean; error?: string; worktree: string; ahead?: number } | null;
}

/** The app's one badge look, by its state class. */
export type Badge = "blocked" | "failed" | "working" | "done" | "idle";

export interface FleetScreenModel {
  projects: ProjectModel[];
  project: { path: string; name: string } | null;
  /** the project's live coordinator, whose pane holds the project conversation */
  coordinator: { runId: string; paneId: string; agent: FleetAgentKind } | null;
  /** the project's threads that wait on the person */
  needs: number;
  threadGroups: Array<{ key: ThreadGroupKey; label: string; rows: ThreadRowModel[] }>;
  resolved: ThreadRowModel[];
  /** every thread of the project the coordinator started, for its cards in the conversation */
  threads: ThreadRowModel[];
  /** runs outside every thread and project conversation */
  agents: RunCardModel[];
  open: OpenRunModel | null;
  overview: boolean;
  expanded: boolean;
  status: "loading" | "ready" | "error";
  error?: string;
  counts: Record<Exclude<RunTone, "ended">, number>;
  sections: Array<{ tone: Exclude<RunTone, "ended">; runs: RunCardModel[] }>;
  ended: RunCardModel[];
  /** groups with finished non-interactive runs whose panes can be closed */
  closableGroups: string[];
  usage: { capsules: UsageCapsuleModel[]; refreshing: boolean; error?: string };
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
  const project = projectsOf(state);
  const view = state.fleetView;
  const threadRuns = project.selected === null ? [] : runs.filter((run) => run.role === THREAD_ROLE && run.project === project.selected);
  const rows = threadRuns.map((run) => threadRow(run, view.open?.kind === "thread" && view.open.runId === run.id));
  const byRecent = (a: ThreadRowModel, b: ThreadRowModel) => b.updatedAt - a.updatedAt;
  const coordinatorRun = project.selected === null ? undefined
    : runs.filter((run) => run.role === PROJECT_ROLE && run.project === project.selected && !isEnded(run)).sort((a, b) => b.startedAt - a.startedAt)[0];
  const inThreads = new Set(runs.filter((run) => run.role === THREAD_ROLE).map((run) => run.group));
  const outside = cards.filter((card) => card.role !== THREAD_ROLE && card.role !== PROJECT_ROLE && !inThreads.has(card.group) && card.tone !== "ended");
  return {
    projects: project.list,
    project: project.selected === null ? null : { path: project.selected, name: baseName(project.selected) },
    coordinator: coordinatorRun ? { runId: coordinatorRun.id, paneId: coordinatorRun.paneId, agent: coordinatorRun.agent } : null,
    needs: rows.filter((row) => row.group === "needs").length,
    threadGroups: GROUPS.map(([key, label]) => ({ key, label, rows: rows.filter((row) => row.group === key).sort(byRecent) })).filter((group) => group.rows.length > 0),
    resolved: rows.filter((row) => row.group === "resolved").sort(byRecent),
    threads: [...rows].sort((a, b) => a.startedAt - b.startedAt),
    agents: outside,
    open: openRun(runs, view, state),
    overview: view.overview,
    expanded: view.expanded && view.open !== null,
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
    requestError: state.request.status === "failed" ? state.request.message : undefined,
    busy: state.request.status === "pending",
    canAct: state.canAct,
  };
}

/** How many runs wait on the person: the count the Fleet button carries. */
export function needsCount(state: Pick<UiState, "runs">): number {
  return state.runs.data.filter((run) => run.state === "blocked").length;
}

/** The roles fleet gives a thread's lead and a project's coordinator (server/fleet/orchestrator.ts). */
const THREAD_ROLE = "lead";
const PROJECT_ROLE = "coordinator";

const GROUPS: ReadonlyArray<[ThreadGroupKey, string]> = [["needs", "Needs you"], ["review", "Ready for review"], ["landing", "Landing"], ["working", "Working"], ["idle", "Idle"]];

/** A thread state's badge word and look: waiting reads Needs you, as every waiting state does. */
const THREAD_BADGE: Record<ThreadState, { label: string; badge: Badge }> = {
  waiting: { label: "Needs you", badge: "blocked" }, failed: { label: "Failed", badge: "failed" }, review: { label: "Ready for review", badge: "done" }, landing: { label: "Landing", badge: "working" },
  working: { label: "Working", badge: "working" }, idle: { label: "Idle", badge: "idle" }, ended: { label: "Ended", badge: "idle" }, resolved: { label: "Resolved", badge: "idle" },
};

const RUN_BADGE: Record<RunTone, { label: string; badge: Badge }> = {
  needs: { label: "Needs you", badge: "blocked" }, failed: { label: "Failed", badge: "failed" }, working: { label: "Working", badge: "working" }, done: { label: "Done", badge: "done" }, ended: { label: "Ended", badge: "idle" },
};

const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

/**
 * The projects: every repository a coordinator or a thread worked for, the most recently active
 * first, and a folder picked for a new one. The one chosen, else the most recently active; a folder
 * chosen inside a listed repository is that repository.
 */
export function projectsOf(state: Pick<UiState, "runs" | "fleetView">): { list: ProjectModel[]; selected: string | null } {
  const runs = state.runs.data.filter((run) => run.project !== undefined && (run.role === THREAD_ROLE || run.role === PROJECT_ROLE));
  const latest = new Map<string, number>();
  for (const run of runs) latest.set(run.project!, Math.max(latest.get(run.project!) ?? 0, run.updatedAt));
  const paths = [...latest.keys()].sort((a, b) => latest.get(b)! - latest.get(a)!);
  const chosen = state.fleetView.project;
  const known = chosen === null ? undefined : paths.find((path) => path === chosen) ?? paths.find((path) => chosen.startsWith(`${path}/`));
  if (chosen !== null && known === undefined) paths.push(chosen);
  const selected = known ?? chosen ?? paths[0] ?? null;
  const list = paths.map((path) => {
    const threads = runs.filter((run) => run.project === path && run.role === THREAD_ROLE).map(threadState);
    const dot = threads.some((s) => s === "waiting" || s === "failed") ? "needs" : threads.some((s) => s === "working") ? "working"
      : runs.some((run) => run.project === path) ? "idle" : "none";
    return { path, name: baseName(path), dot, selected: path === selected } as ProjectModel;
  });
  return { list, selected };
}

function threadRow(run: AgentRun, selected: boolean): ThreadRowModel {
  const state = threadState(run);
  const status = run.result ? handoffStatus(run.result) : undefined;
  const group: ThreadRowModel["group"] = state === "waiting" || state === "failed" ? "needs" : state === "review" || state === "landing" || state === "working" || state === "resolved" ? state : "idle";
  const failing = run.pr?.state === "OPEN" && run.pr.checks === "fail" ? `PR #${run.pr.number}: ${(run.pr.failing ?? []).join(", ")}` : undefined;
  const question = state === "failed" ? run.lastError : state !== "waiting" ? undefined
    : run.state === "blocked" ? run.lastError : status?.startsWith("BLOCKED") ? status : run.landing?.error ?? failing ?? status;
  return {
    id: run.id, title: run.name, state, group, ...THREAD_BADGE[state], agent: run.agent, branch: run.branch, diff: run.diff, contract: run.contract ?? [], ...(run.pr ? { pr: run.pr } : {}),
    ...(question ? { question } : {}), startedAt: run.startedAt, updatedAt: run.updatedAt, selected,
  };
}

function openRun(runs: AgentRun[], view: UiState["fleetView"], fleet: FleetState): OpenRunModel | null {
  const open = view.open;
  const run = open ? runs.find((candidate) => candidate.id === open.runId) : undefined;
  if (!open || !run) return null;
  const helpers = open.kind === "thread" ? runs.filter((other) => other.group === run.group && other.id !== run.id) : [];
  const member = open.member === null ? undefined : helpers.find((helper) => helper.id === open.member);
  const shown = member ?? run;
  const state = open.kind === "thread" ? threadState(run) : undefined;
  const look = state ? THREAD_BADGE[state] : RUN_BADGE[toneOf(run.state)];
  return {
    kind: open.kind, runId: run.id, title: run.name, ...look, paneId: shown.paneId, paneRunId: shown.id, agent: shown.agent, ended: isEnded(shown),
    meta: [shown.role, shown.agent, shown.model].filter(Boolean).join(" · "), branch: run.branch, diff: run.diff, contract: run.contract ?? [],
    members: open.kind === "thread" ? [run, ...helpers].map((each) => ({
      runId: each.id === run.id ? null : each.id, name: each.id === run.id ? "lead" : each.name, agent: each.agent,
      ...RUN_BADGE[toneOf(each.state)], selected: each.id === shown.id,
    })) : [],
    skipped: shown.skipped ?? [],
    canResolve: open.kind === "thread" && state !== "working" && state !== "resolved" && !run.landed,
    // a thread that landed has no worktree left to open again
    resolved: state === "resolved" && !run.landed,
    landing: open.kind === "thread" && run.branch && run.project ? landingModel(run as AgentRun & { branch: string; project: string }, helpers, view.tab, fleet) : null,
  };
}

/** What landing the open thread looks like now. */
function landingModel(run: AgentRun & { branch: string; project: string }, helpers: AgentRun[], tab: ThreadTab, fleet: FleetState): LandingModel {
  const landing = fleet.landing;
  const read = landing.runId === run.id;
  const checks = read ? landing.checks.data : null;
  const baseBranch = checks?.baseBranch ?? run.baseBranch ?? "main";
  const comments = landing.comments[run.id] ?? [];
  const prOpen = run.pr?.state === "OPEN";
  const stage = run.landed ? "landed" : prOpen ? "landing" : "review";
  const pending = run.landing && !run.landing.error ? run.landing.action : undefined;
  const free = fleet.canAct && fleet.request.status !== "pending" && !run.landed;
  const settled = free && pending === undefined;
  const changed = (run.diff?.files ?? 0) > 0 || (checks?.ahead ?? 0) > 0;
  const files = read && landing.diff.data ? parseDiff(landing.diff.data.diff).map((file) => {
    const on = comments.map((comment, index) => ({ ...comment, index })).filter((comment) => comment.file === file.path);
    return {
      ...file,
      comments: on.length,
      lines: file.lines.map((line) => ({
        ...line,
        comments: on.filter((comment) => (comment.removed ? line.kind === "del" && line.old === comment.line : line.kind !== "del" && line.new === comment.line)).map((comment) => ({ index: comment.index, text: comment.text })),
      })),
    };
  }) : [];
  const reviewers = helpers.filter((helper) => helper.role === "reviewer" && helper.agent !== run.agent);
  const contractOpen = (run.contract ?? []).some((item) => item.state !== "met");
  const branchChecks: CheckModel[] = checks ? [
    { kind: "committed", tone: checks.uncommitted.length ? "warn" : "ok", uncommitted: checks.uncommitted, ahead: checks.ahead },
    { kind: "base", tone: checks.behind ? "warn" : "ok", baseBranch, behind: checks.behind, ...(checks.behind ? { action: "update" as const } : {}) },
  ] : [];
  const threadChecks: CheckModel[] = [
    { kind: "contract", tone: !run.contract?.length ? "none" : contractOpen ? "warn" : "ok", items: run.contract ?? [] },
    { kind: "review", tone: reviewers.length ? "ok" : "warn", reviewers: reviewers.map((helper) => ({ agent: helper.agent, ...(helper.result && handoffStatus(helper.result) ? { status: handoffStatus(helper.result) } : {}) })) },
    { kind: "comments", tone: comments.length ? "warn" : "ok", count: comments.length, ...(comments.length ? { action: "comments" as const } : {}) },
  ];
  const pr = checks?.pr ?? run.pr;
  const prChecks: CheckModel[] = [
    { kind: "pr", tone: pr?.state === "OPEN" || pr?.state === "MERGED" ? "ok" : checks?.prError ? "warn" : "none", ...(pr ? { pr } : {}), ...(checks?.prError ? { error: checks.prError } : {}) },
    ...(pr?.state === "OPEN" ? [{ kind: "ci" as const, pr, tone: CI_TONE[pr.checks], ...(pr.checks === "fail" ? { action: "fix-ci" as const } : {}) }] : []),
  ];
  const confirm = landing.confirm?.runId === run.id ? landing.confirm : null;
  return {
    runId: run.id, branch: run.branch, baseBranch, repo: run.project, tab, stage, ...(run.landed ? { landed: run.landed } : {}),
    ...(pending ? { pending } : {}), ...(run.landing?.error ? { error: run.landing.error } : {}), ...(run.pr ? { pr: run.pr } : {}),
    offers: {
      createPr: stage === "review" && changed, mergeLocal: stage === "review" && changed, discard: stage === "review",
      fixCi: prOpen && run.pr?.checks === "fail", mergePr: prOpen,
    },
    can: { lead: settled && (run.state === "idle" || run.state === "done"), merge: settled && run.state !== "working" && run.state !== "starting", discard: free },
    mergePrReady: prOpen && (run.pr?.checks === "pass" || run.pr?.checks === "none"),
    comments,
    changes: { status: read ? landing.diff.status : "idle", ...(read && landing.diff.error ? { error: landing.diff.error } : {}), truncated: read && landing.diff.data?.truncated === true, files },
    checks: { status: read ? landing.checks.status : "idle", ...(read && landing.checks.error ? { error: landing.checks.error } : {}), branch: branchChecks, thread: threadChecks, pr: prChecks },
    attention: comments.length > 0 || (prOpen && run.pr?.checks === "fail") || run.landing?.error !== undefined,
    confirm: confirm ? {
      action: confirm.action, running: confirm.status === "running", ...(confirm.error ? { error: confirm.error } : {}),
      worktree: `${run.project}/.herdr-fleet/worktrees/${run.id}`, ...(checks ? { ahead: checks.ahead } : {}),
    } : null,
  };
}

const CI_TONE: Record<PullRequest["checks"], CheckTone> = { pending: "run", pass: "ok", fail: "bad", none: "none" };

/**
 * Where a thread's card goes in the project conversation: under the coordinator's turn it was
 * started in (the last turn of the agent's that began before it), keyed by that turn's time.
 */
export function threadCards(turns: ConversationTurn[], threads: ThreadRowModel[]): Map<string, ThreadRowModel[]> {
  const agentTurns = turns.filter((turn) => turn.role === "assistant" && turn.ts !== null).map((turn) => ({ ts: turn.ts!, at: Date.parse(turn.ts!) })).filter((turn) => !Number.isNaN(turn.at));
  const cards = new Map<string, ThreadRowModel[]>();
  for (const thread of threads) {
    const turn = agentTurns.filter((candidate) => candidate.at <= thread.startedAt).at(-1);
    if (turn) cards.set(turn.ts, [...(cards.get(turn.ts) ?? []), thread]);
  }
  return cards;
}
