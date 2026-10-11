/**
 * The fleet's records as the server keeps them and the API sends them: runs (server/fleet) and the
 * usage the fleet knows (server/fleet/usage.ts). Shared so the Web UI reads the same shapes.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** herdr's agent states, plus what the fleet adds: starting (no state yet), failed and stopped (the run is over). */
export type AgentState = "starting" | "working" | "idle" | "done" | "blocked" | "unknown" | "failed" | "stopped";

/** The agent CLIs the fleet can start: herdr's `agent start --kind` values it has an adapter for (server/fleet/adapters.ts). */
export type FleetAgentKind = "pi" | "claude" | "codex" | "cursor" | "agy";

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

/** One account the fleet tracks: a CLI, or a part of one with its own limits (agy's model groups, pi's providers). */
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
  const status = run.result ? handoffStatus(run.result) : undefined;
  if (status?.startsWith("BLOCKED") || run.landing?.error || (run.pr?.state === "OPEN" && run.pr.checks === "fail")) return "waiting";
  if (run.pr?.state === "OPEN") return "landing";
  return status?.startsWith("PASS") ? "review" : "idle";
}
