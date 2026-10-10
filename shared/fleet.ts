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
}

/** One assertion of a thread lead's acceptance contract (contract.md), as the lead last marked it. */
export interface ContractItem {
  id: string;
  state: "met" | "open" | "unmet";
}

/**
 * Where a thread stands for the person: its lead at work, waiting on the person (a question in its
 * HANDOFF or on its screen), done with a PASS, settled otherwise, failed, or its pane gone.
 */
export type ThreadState = "working" | "waiting" | "review" | "idle" | "failed" | "ended";

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
