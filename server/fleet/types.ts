/**
 * The fleet: agents this server starts in herdr panes on a caller's behalf, each a run with a
 * role, followed turn by turn until it settles. Ported from pi-herdr-fleet, without pi.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Config and frontmatter: an unknown value is dropped, not an error for the whole file. */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return isThinkingLevel(value) ? value : undefined;
}

/** A spawn request: a value given explicitly has to be a known level. */
export function requireThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null) return undefined;
  if (isThinkingLevel(value)) return value;
  throw new Error(`Invalid thinking level ${JSON.stringify(value)}. Use one of: ${THINKING_LEVELS.join(", ")}.`);
}

/** herdr's agent states, plus what the fleet adds: starting (no state yet), failed and stopped (the run is over). */
export type AgentState = "starting" | "working" | "idle" | "done" | "blocked" | "unknown" | "failed" | "stopped";

/** The agent CLIs the fleet can start: herdr's `agent start --kind` values it has an adapter for (adapters.ts). */
export type AgentKind = "pi" | "claude" | "codex" | "cursor" | "agy";

/** A role: what an agent is told to be (the markdown body) and how it runs, from agents/*.md. */
export interface AgentDefinition {
  name: string;
  description: string;
  /** which agent CLI plays the role; pi when the file names none */
  agent: AgentKind;
  model?: string;
  thinking?: ThinkingLevel;
  fallbackModels?: string[];
  /** the agent CLI's own tool names, for the CLIs that take a list (pi) */
  tools?: string[];
  systemPrompt: string;
  worktree?: boolean;
  interactive?: boolean;
  spawning?: boolean;
  source: "project" | "user" | "bundled";
  filePath: string;
}

/** What config.roles.<name> changes about a role. */
export interface RoleOverride {
  agent?: AgentKind;
  model?: string;
  thinking?: ThinkingLevel;
  /** models to try, in order, when the primary one cannot start or fails its first turn */
  fallbackModels?: string[];
  worktree?: boolean;
  interactive?: boolean;
  spawning?: boolean;
}

export interface ModelPolicy {
  /** the thinking levels this model may run at; none listed means any */
  thinking?: ThinkingLevel[];
}

export interface FleetConfig {
  defaultModel?: string;
  defaultThinking?: ThinkingLevel;
  /** runs starting or working at once; idle, done and blocked ones do not count */
  maxConcurrent: number;
  /** how deep agents may spawn agents: the caller is depth 0 */
  maxDepth: number;
  recentReadLines: number;
  defaultWaitTimeoutMs: number;
  /** close a non-interactive agent's pane once its turn settles */
  closeOnSettle: boolean;
  roles: Record<string, RoleOverride>;
  models: Record<string, ModelPolicy>;
}

export interface AgentRun {
  id: string;
  name: string;
  role: string;
  agent: AgentKind;
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
}

export interface SpawnRequest {
  name?: string;
  role: string;
  task: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  worktree?: boolean;
  interactive?: boolean;
  direction?: "right" | "down";
  /** the caller's fleet; a new one is named when absent */
  group?: string;
  /** the caller's depth: 0 for a person or a top-level agent */
  depth?: number;
  /** the pane the caller runs in: a new agent opens beside it */
  callerPaneId?: string;
}
