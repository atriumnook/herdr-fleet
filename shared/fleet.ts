/**
 * The fleet's records as the server keeps them and the API sends them: runs (server/fleet) and the
 * usage the fleet knows (server/fleet/usage.ts). Shared so the Web UI reads the same shapes.
 */

import type { PlanMark } from "./plan.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** herdr's agent states, plus what the fleet adds: starting (no state yet), failed and stopped (the run is over). */
export type AgentState = "starting" | "working" | "idle" | "done" | "blocked" | "unknown" | "failed" | "stopped";

/** The agent CLIs the fleet can start: herdr's `agent start --kind` values it has an adapter for (server/fleet/adapters.ts). */
export type FleetAgentKind = "pi" | "claude" | "codex" | "cursor" | "agy" | "opencode";

/**
 * A run that wrote in a thread, or reviewed it: its CLI and model, which tell the model's company
 * (shared/model-company.ts). A record from before writers named their model holds the CLI alone.
 */
export interface Writer {
  agent: FleetAgentKind;
  model?: string;
}

/** A spawn candidate passed over before the one a run started on, and why. */
export interface SkippedCandidate {
  /** the candidate entry as configured: a model, or `<agent>:<model>` */
  candidate: string;
  reason: string;
}

export interface AgentRun {
  id: string;
  name: string;
  role: string;
  agent: FleetAgentKind;
  /** the fleet this run belongs to: its caller's, so a caller lists only its own agents */
  group: string;
  /** herdr's agent name, unique per run */
  herdrName: string;
  paneId: string;
  workspaceId?: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  state: AgentState;
  depth: number;
  interactive: boolean;
  worktree: boolean;
  startedAt: number;
  updatedAt: number;
  lastOutput?: string;
  lastError?: string;
  /** the HANDOFF the agent wrote to its result file during its last settled turn; none if it wrote none then */
  result?: string;
  /** what its last settled turn reported (report.json), or that it reported nothing; none for a run without a result file */
  outcome?: TurnOutcome;
  /**
   * a reviewer's: the commit its folder was at when the fleet sent its last turn, and the commit the
   * turn that left `outcome` reviewed (kept only when the folder did not move during that turn)
   */
  turnHead?: string;
  /** a reviewer's: the state of its folder's worktree when the fleet sent its last turn (github.ts worktreeState) */
  turnTree?: string;
  /** a reviewer's: the fleet read its last turn settle, and that turn changed nothing in the worktree; nothing ran in it since */
  reviewClean?: true;
  reportedHead?: string;
  /** a thread lead's: every CLI and model that wrote in the thread so far (its lead runs, helpers that edit, a reviewer whose turn saw the branch move) */
  writers?: Writer[];
  /** the run's role kept it from editing files when it started */
  readOnly?: true;
  /** the model this run replaced after a configured fallback */
  fallbackFrom?: string;
  /** the run that took this run's task over: after a first turn that failed, or, for a thread's lead, a run that failed or a turn without a report */
  replacedBy?: string;
  /** the thread a lead took over from an earlier run of it: that first run's id, which names the thread's worktree and branch */
  thread?: string;
  /** the CLIs a thread's lead runs failed on, or ended a turn without a report on, since the thread's last report: its next restart passes them over */
  avoid?: FleetAgentKind[];
  /** candidates passed over before this one: no usage left, cooling down, or failed to start */
  skipped?: SkippedCandidate[];
  /** a thread lead's branch, when its thread works on a worktree */
  branch?: string;
  /** the repository a thread or a project's coordinator works for */
  project?: string;
  /** the run that started this thread, a project's coordinator: its results and questions go there */
  owner?: string;
  /** the paths its brief lets it change, absolute; another run may not write them while it works */
  write?: string[];
  /** a thread's question for the person that its project's coordinator has not been given yet */
  notice?: string;
  /** the commit a thread's worktree started from: its change is measured against it */
  base?: string;
  /** a thread lead's acceptance contract, as it stood when the lead's turn last settled */
  contract?: ContractItem[];
  /** what a thread changed since `base`, as it stood when the lead's turn last settled */
  diff?: DiffStat;
  /** when the person marked the thread done (epoch ms); its lead working again takes it back */
  resolvedAt?: number;
  /** the branch the repository's main checkout was on when the thread started: the thread lands there */
  baseBranch?: string;
  /** the thread's pull request, as the fleet last read it from GitHub */
  pr?: PullRequest;
  /** the landing step the person asked for last, until it went as asked */
  landing?: LandingStep;
  /** how the thread ended: merged into its base branch, or thrown away */
  landed?: "merged" | "discarded";
  /** the plan a thread's lead handed over last (shared/plan.ts), and whether the person answered it */
  plan?: PlanMark;
  /** the gate of the project's gated merge authority, as the fleet last evaluated it for this thread */
  gate?: GateReading;
  /** how the thread's merge happened: who merged it, through its pull request on GitHub or into the base branch here, and its merge commit when git or GitHub named it */
  merged?: { by: MergeBy; via: "pr" | "local"; base: string; at: number; commit?: string };
  /** the revert of that merge the fleet saw land on the base branch */
  reverted?: { at: number; commit: string };
}

/**
 * Who merged a thread: the coordinator on a merge the person pressed (person), the coordinator on
 * its own because every condition of the gate held (gate), or someone outside the fleet's steps,
 * seen merged on GitHub (github).
 */
export type MergeBy = "person" | "gate" | "github";

/** A project's merge authority, as the person's own fleet.json sets it (server/fleet/merge-mode.ts). */
export interface MergeSetting {
  mode: "person" | "gated";
  /** the base branches gated covers; a merge into any other waits for the person */
  branches: string[];
  /** the most lines (added and removed) a change merged on its own may have */
  maxLines: number;
  /** paths and globs a change merged on its own may not touch, beside those the fleet always protects */
  protected: string[];
}

/** One condition of the merge gate and what the fleet found. */
export interface GateCheck {
  id: "report" | "review" | "checks" | "size" | "paths" | "fresh";
  ok: boolean;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  checks: GateCheck[];
}

/** The gate evaluated for a thread: when, at which commit of its branch, and the result. */
export interface GateReading extends GateResult {
  at: number;
  head?: string;
}

/**
 * The steps that land a thread, each pressed by the person on the Fleet screen. The lead takes
 * those on its branch (update, pr, fix-ci, comments), the coordinator the merges, which happen in
 * the main checkout it sits on, and its revert once merged (revert), and the fleet throws a thread
 * away itself (discard).
 */
export type LandAction = "update" | "pr" | "fix-ci" | "comments" | "merge" | "merge-pr" | "revert" | "discard";

/** One landing step the person asked for: handed to its agent (`sent`), and what the fleet found once that agent's turn ended. */
export interface LandingStep {
  action: LandAction;
  at: number;
  sent?: boolean;
  /** a merge the person did not press: the fleet found every condition of the project's gate held, for the pull request at commit `head` */
  by?: "gate";
  head?: string;
  /** the pull request the gate checked */
  pr?: number;
  /** the step did not go as asked: what the fleet found */
  error?: string;
}

/**
 * The states an agent reports a turn in (dsh-superagent's Report): still at it and going on by
 * itself (progress), its turn done and waiting for a helper or a message (waiting), the task done
 * and checked (ready), unable to go on without the person (blocked), tried and could not (failed),
 * nothing to do (dropped).
 */
export const REPORT_STATES = ["progress", "waiting", "ready", "blocked", "failed", "dropped"] as const;
export type ReportState = typeof REPORT_STATES[number];

/** An agent's report of its turn, from report.json beside its handoff (server/fleet/report.ts). */
export interface RunReport {
  state: ReportState;
  summary: string;
  /** what the agent ran and what it showed */
  evidence: string[];
  /** one concrete question for the person, when the person must act */
  human_action?: string;
}

/** What a settled turn reported: the report, or none, and why (nothing is read from the agent's prose). */
export type TurnOutcome = { report: RunReport } | { report: null; problem: string };

/** A thread's pull request on GitHub, and its checks: failing ones by name. */
export interface PullRequest {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  checks: "pending" | "pass" | "fail" | "none";
  failing?: string[];
}

/** One comment of the person's on a thread's change, sent to its lead with the others: on a line of the new file, or one it removed. */
export interface LineComment {
  file: string;
  line: number;
  removed?: boolean;
  text: string;
}

/** What stands between a thread and landing, read when asked: its worktree, its branch beside the base, its pull request. */
export interface LandingChecks {
  baseBranch: string;
  /** files changed or new in the worktree that no commit holds (git status), the first 20 */
  uncommitted: string[];
  /** commits the branch has that the base branch does not, and the other way round */
  ahead: number;
  behind: number;
  pr?: PullRequest;
  /** GitHub could not be asked (gh missing, signed out, offline) */
  prError?: string;
}

/** Lines a change adds and removes, in the files git tracks. */
export interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

/** One assertion of a thread lead's acceptance contract (contract.md), as the lead last marked it. */
export interface ContractItem {
  id: string;
  state: "met" | "open" | "unmet";
}

/**
 * Where a thread stands for the person: its lead at work, waiting on the person (a report that
 * needs them or no report, a question on its screen, a landing step that went wrong, failing
 * checks), reported ready, its pull request open, settled otherwise, failed, its pane gone, or
 * marked done.
 */
export type ThreadState = "working" | "waiting" | "review" | "landing" | "idle" | "failed" | "ended" | "resolved";

/** A thread as its project's coordinator sees it: the lead's run, where it stands, its last report, and its contract. */
export interface ThreadSummary {
  run: AgentRun;
  state: ThreadState;
  /** the last report's state and summary, or that the turn left none and why (outcomeLine) */
  status?: string;
  contract?: ContractItem[];
}

/** One limit window: a share of it used, until it resets. */
export interface UsageWindow {
  /** "5h", "weekly", "monthly", … */
  name: string;
  usedPercent: number;
  /** epoch ms; unknown for some sources */
  resetsAt?: number;
}

export interface UsageReading {
  windows: UsageWindow[];
  readAt: number;
}

export interface Cooldown {
  until: number;
  reason: string;
  since: number;
}

/** One account the fleet tracks: a CLI, or a part of one with its own limits (agy's model groups, the providers of pi and opencode). */
export interface UsageEntry {
  key: string;
  reading?: UsageReading;
  cooldown?: Cooldown;
  /** the last reading attempt failed; the reading kept is older */
  error?: string;
}

/** A report the person has to act on: it says so with a question, or the agent is blocked or could not do it. */
export function needsPerson(report: RunReport): boolean {
  return report.human_action !== undefined || report.state === "blocked" || report.state === "failed";
}

/** A turn's outcome in a line: the report's state and summary, or that there is none and why. */
export function outcomeLine(outcome: TurnOutcome): string {
  return outcome.report ? `${outcome.report.state} — ${outcome.report.summary}` : `no report — ${outcome.problem}`;
}

/** contract.md's assertions: `- [ ] A1 …` open, `- [x]` met, `- [!]` cannot be met. */
export function contractItems(text: string): ContractItem[] {
  return [...text.matchAll(/^\s*[-*]\s*\[([ xX!])\]\s*(A\d+)\b/gm)].map((m) => ({
    id: m[2]!, state: m[1] === "!" ? "unmet" : m[1] === " " ? "open" : "met",
  }));
}

/** The run that leads a thread now: `id`, or the lead run that took the thread over from it (`replacedBy`). */
export function currentLead(runs: readonly AgentRun[], id: string): AgentRun | undefined {
  let run = runs.find((candidate) => candidate.id === id);
  for (let hops = 0; run?.role === "lead" && run.replacedBy && hops < 32; hops++) {
    const next = runs.find((candidate) => candidate.id === run!.replacedBy);
    if (!next) break;
    run = next;
  }
  return run;
}

/** Where a thread stands: herdr's state of its lead, and once a turn settled, what it reported. */
export function threadState(run: AgentRun): ThreadState {
  const working = run.state === "starting" || run.state === "working" || run.state === "unknown";
  if (run.resolvedAt !== undefined && !working) return "resolved";
  if (run.state === "failed") return "failed";
  if (run.state === "stopped") return "ended";
  if (run.state === "blocked") return "waiting";
  if (working) return "working";
  // a plan waits on the person through the blocked report its turn ends with (agents/lead.md),
  // not by itself: a lead that went on without the answers is not waiting. A turn that left no
  // report is someone's to look at: the fleet starts a lead's thread again when it can.
  const report = run.outcome?.report;
  if ((report && needsPerson(report)) || run.outcome?.report === null || run.landing?.error || (run.pr?.state === "OPEN" && run.pr.checks === "fail")) return "waiting";
  if (run.pr?.state === "OPEN") return "landing";
  return report?.state === "ready" ? "review" : "idle";
}

/** One candidate of a role: the CLI, and its model (none: the CLI's own default). */
export interface RoleCandidate {
  agent: FleetAgentKind;
  model?: string;
}

/** A role as the Settings page draws it. */
export interface RoleSettings {
  name: string;
  description: string;
  /** the role edits no file: only a CLI the fleet can keep from editing plays it */
  readOnly: boolean;
  /** the candidates in the order the fleet tries them, as the role's file and the person's fleet.json set them, each with why it would be passed over now */
  candidates: Array<RoleCandidate & { skip?: string }>;
  thinking?: ThinkingLevel;
  /** the person's fleet.json sets the candidates or the thinking level */
  changed: boolean;
  /** what the role's file alone sets: Reset goes back to it */
  defaults: { candidates: RoleCandidate[]; thinking?: ThinkingLevel };
  /** set when the project's own `.herdr-fleet/fleet.json` sets the role: the fleet uses these in that project */
  project?: { candidates: RoleCandidate[]; thinking?: ThinkingLevel };
}

/** The fleet's settings from the person's fleet.json, with what each role and the project make of them. */
export interface FleetSettings {
  /** the person's fleet.json, where every change is saved */
  file: string;
  roles: RoleSettings[];
  /** a candidate is passed over while a window of its account is used this much (percent) */
  maxUsedPercent: number;
  /** how long an account sits out after a rate limit whose message names no time (minutes) */
  rateLimitCooldownMinutes: number;
  /** agents starting or working at once */
  maxConcurrent: number;
  /** a helper's pane closes when its turn ends */
  closeOnSettle: boolean;
  /** the language the person reads, such as Japanese; empty when unset */
  language: string;
  /** each repository the person's fleet.json names: its setup command, and its merge authority (person unless set) */
  projects: Array<{ path: string; setup: string; merge: MergeSetting }>;
  /** the CLIs a read-only role can run on */
  readOnlyAgents: FleetAgentKind[];
}

/** A change to the person's fleet.json: what is named changes, the rest stays. A role set to null goes back to its file's candidates. */
export interface FleetSettingsPatch {
  roles?: Record<string, { candidates: RoleCandidate[]; thinking?: ThinkingLevel | null } | null>;
  maxUsedPercent?: number;
  rateLimitCooldownMinutes?: number;
  maxConcurrent?: number;
  closeOnSettle?: boolean;
  /** an empty language unsets it */
  language?: string;
  /** an empty setup command removes it; merge mode person removes the merge setting */
  projects?: Record<string, { setup?: string; merge?: MergeSetting }>;
}

/**
 * A folder agent CLIs read skills from, where the Settings page puts the fleet skill: with it, an
 * agent in a pane's conversation hands work to the project's coordinator.
 */
export interface FleetEntrance {
  id: "claude" | "agents" | "gemini";
  /** the skill's file, absolute */
  file: string;
  /** the CLIs that read skills from this folder */
  readers: FleetAgentKind[];
  /** installed: as the fleet writes it now; outdated: the fleet wrote it for another command or address; taken: a file the fleet did not write is there */
  state: "installed" | "missing" | "outdated" | "taken";
}

export interface FleetEntrances {
  entrances: FleetEntrance[];
  /** the server wants a token, which the skill does not carry: a pane needs HERDR_FLEET_TOKEN set */
  tokenRequired: boolean;
}

/**
 * The models one agent CLI says it offers. `complete`: the list is the CLI's whole answer, so a
 * model outside it will not run; otherwise it holds only names the CLI is known to accept (claude's
 * aliases, pi's patterns), and any other name may still work.
 */
export interface ModelListing {
  agent: FleetAgentKind;
  models: Array<{ id: string; label?: string }>;
  complete: boolean;
  /** why the CLI could not be asked; `models` is then empty */
  error?: string;
}

/**
 * Whether `model` is one the listing names. A `:level` suffix is not part of a name, cursor's
 * bracketed parameters (`gpt-5[effort=high]`) belong to one model, and opencode's `#variant` is a
 * way to run the model the listing names without it.
 */
export function modelListed(listing: ModelListing, model: string): boolean {
  const bare = (name: string) => name.replace(/\[.*\]$/, "");
  const unsuffixed = model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
  const name = bare(listing.agent === "opencode" ? unsuffixed.replace(/#[^#]+$/, "") : unsuffixed);
  // agy lists a model once per effort (`gemini-3.1-pro-high`) and takes the effort apart, by `--effort`
  const base = (id: string) => (listing.agent === "agy" ? id.replace(/-(low|medium|high|xhigh|max)$/, "") : id);
  return listing.models.some((each) => each.id === name || bare(each.id) === name || base(each.id) === name);
}

/** How a task sent from a pane's conversation opens (the fleet skill's `fleet project`), so the coordinator and the Fleet screen tell where it came from. */
export const FROM_PANE = "[from pane ";

/** The pane a message to a coordinator was sent from, and the message without that opening line; none for one the person typed on the Fleet screen. */
export function fromPane(text: string): { paneId: string; text: string } | null {
  const match = /^\[from pane ([\w:.-]{1,64})\]\n\n/.exec(text);
  return match ? { paneId: match[1]!, text: text.slice(match[0].length) } : null;
}
