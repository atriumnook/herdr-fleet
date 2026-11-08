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
  /** the model this run replaced after a configured fallback */
  fallbackFrom?: string;
  /** the run that took this run's task over after its first turn failed */
  replacedBy?: string;
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
}

/**
 * The steps that land a thread, each pressed by the person on the Fleet screen. The lead takes
 * those on its branch (update, pr, fix-ci, comments), the coordinator the merges, which happen in
 * the main checkout it sits on, and the fleet throws a thread away itself (discard).
 */
export type LandAction = "update" | "pr" | "fix-ci" | "comments" | "merge" | "merge-pr" | "discard";

/** One landing step the person asked for: handed to its agent (`sent`), and what the fleet found once that agent's turn ended. */
export interface LandingStep {
  action: LandAction;
  at: number;
  sent?: boolean;
  /** the step did not go as asked: what the fleet found */
  error?: string;
}

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
 * Where a thread stands for the person: its lead at work, waiting on the person (a question in its
 * HANDOFF or on its screen, a landing step that went wrong, failing checks), done with a PASS, its
 * pull request open, settled otherwise, failed, its pane gone, or marked done.
 */
export type ThreadState = "working" | "waiting" | "review" | "landing" | "idle" | "failed" | "ended" | "resolved";

/** A thread as its project's coordinator sees it: the lead's run, where it stands, its HANDOFF status line, and its contract. */
export interface ThreadSummary {
  run: AgentRun;
  state: ThreadState;
  /** the HANDOFF's first line: PASS, ISSUES or BLOCKED and the evidence */
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

/** The HANDOFF's status line: the first that opens with PASS, ISSUES or BLOCKED, without its markdown. */
export function handoffStatus(result: string): string | undefined {
  return result.split("\n").map((l) => l.replace(/^[\s#>-]+/, "").replace(/\*\*/g, "").trim()).find((l) => /^(PASS|ISSUES|BLOCKED)\b/.test(l));
}

/** contract.md's assertions: `- [ ] A1 …` open, `- [x]` met, `- [!]` cannot be met. */
export function contractItems(text: string): ContractItem[] {
  return [...text.matchAll(/^\s*[-*]\s*\[([ xX!])\]\s*(A\d+)\b/gm)].map((m) => ({
    id: m[2]!, state: m[1] === "!" ? "unmet" : m[1] === " " ? "open" : "met",
  }));
}

/** Where a thread stands: herdr's state of its lead, and once a turn settled, the HANDOFF's verdict. */
export function threadState(run: AgentRun): ThreadState {
  const working = run.state === "starting" || run.state === "working" || run.state === "unknown";
  if (run.resolvedAt !== undefined && !working) return "resolved";
  if (run.state === "failed") return "failed";
  if (run.state === "stopped") return "ended";
  if (run.state === "blocked") return "waiting";
  if (working) return "working";
  // a plan waits on the person through the BLOCKED HANDOFF its turn ends with (agents/lead.md),
  // not by itself: a lead that went on without the answers is not waiting
  const status = run.result ? handoffStatus(run.result) : undefined;
  if (status?.startsWith("BLOCKED") || run.landing?.error || (run.pr?.state === "OPEN" && run.pr.checks === "fail")) return "waiting";
  if (run.pr?.state === "OPEN") return "landing";
  return status?.startsWith("PASS") ? "review" : "idle";
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
  /** the setup command of each repository the person's fleet.json names */
  projects: Array<{ path: string; setup: string }>;
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
  /** an empty setup command removes it */
  projects?: Record<string, { setup: string }>;
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
