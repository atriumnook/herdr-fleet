/**
 * The fleet: agents this server starts in herdr panes on a caller's behalf, each a run with a
 * role, followed turn by turn until it settles. Ported from pi-herdr-fleet, without pi.
 */

import type { FleetAgentKind, ThinkingLevel } from "../../shared/fleet.ts";

export type { AgentRun, AgentState, ThinkingLevel } from "../../shared/fleet.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

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

/** The agent CLIs the fleet can start (adapters.ts). */
export type AgentKind = FleetAgentKind;

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
  /**
   * candidates to try, in order, when the primary one cannot start, fails its first turn or has no
   * usage left: a model of the role's CLI, or `<agent>:<model>` for another CLI's
   */
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
  /** a spawn candidate is skipped while any limit window of its account is used this much (percent) */
  maxUsedPercent: number;
  /** how long an account sits out after a rate limit whose message names no time */
  rateLimitCooldownMinutes: number;
  roles: Record<string, RoleOverride>;
  models: Record<string, ModelPolicy>;
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
