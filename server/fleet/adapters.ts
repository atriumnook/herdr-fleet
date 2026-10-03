import type { AgentKind, ThinkingLevel } from "./types.ts";

export interface LaunchOptions {
  model?: string;
  thinking?: ThinkingLevel;
  /** the role's tool list, in this CLI's own tool names */
  tools?: string[];
  /** shown as the session's name where the CLI has one */
  name: string;
  /** a file holding the role and fleet instructions: herdr refuses multiline argv, so it never goes inline */
  systemPromptFile: string;
}

/** What differs between agent CLIs: how one is launched, and how it says it failed. */
export interface AgentAdapter {
  readonly kind: AgentKind;
  /** argv after the executable, for herdr's `agent.start` */
  launchArgs(options: LaunchOptions): string[];
  /** the CLI gave up while starting: the screen it left, read once no agent runs in the pane */
  startupError(screen: string): string | undefined;
  /** a turn that settled without doing the work (an API error after the CLI's own retries) */
  turnError(output: string | undefined): string | undefined;
}

/** `model` as pi takes it: a `:level` suffix sets thinking; one already there wins. */
export function withThinking(model: string, thinking?: ThinkingLevel): string {
  if (!thinking || /:(off|minimal|low|medium|high|xhigh|max)$/.test(model)) return model;
  return `${model}:${thinking}`;
}

/**
 * pi prints an exhausted request as a line `Error: <reason>` and ends the turn. A turn that
 * did its work ends with the HANDOFF section the fleet asks for, so an `Error:` line without
 * one is a failed turn; an error quoted inside a real handoff is not.
 */
export function piTurnError(output: string | undefined): string | undefined {
  if (!output || /HANDOFF/.test(output)) return undefined;
  return [...output.matchAll(/^\s*Error: (.+?)\s*$/gm)].pop()?.[1];
}

export const piAdapter: AgentAdapter = {
  kind: "pi",
  launchArgs({ model, thinking, tools, name, systemPromptFile }) {
    const args: string[] = [];
    if (model) args.push("--model", withThinking(model, thinking));
    if (tools?.length) args.push("--tools", tools.join(","));
    args.push("--name", `fleet:${name}`, "--append-system-prompt", systemPromptFile);
    return args;
  },
  startupError(screen) {
    return [...screen.matchAll(/^\s*Error: (.+)$/gm)].pop()?.[1]?.trim();
  },
  turnError: piTurnError,
};

const ADAPTERS: Record<AgentKind, AgentAdapter> = { pi: piAdapter };

export function adapterFor(kind: AgentKind): AgentAdapter {
  return ADAPTERS[kind];
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && Object.hasOwn(ADAPTERS, value);
}
