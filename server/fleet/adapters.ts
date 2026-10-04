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
  /** the same instructions as text, for a CLI that takes them in a config value (codex) */
  systemPrompt: string;
  /** the run's result folder: outside the workspace, so a CLI that confines writes is told it may write there */
  resultDir: string;
}

/** What differs between agent CLIs: how one is launched, and how it says it failed. */
export interface AgentAdapter {
  readonly kind: AgentKind;
  /** the CLI takes no instructions at launch: they lead the first prompt instead */
  readonly instructionsInPrompt: boolean;
  /** argv after the executable, for herdr's `agent.start` */
  launchArgs(options: LaunchOptions): string[];
  /** the CLI gave up while starting: the screen it left, read once no agent runs in the pane */
  startupError(screen: string): string | undefined;
  /**
   * The screen once herdr calls the agent ready, for what herdr cannot see: a question it reports
   * as idle (`blocked`), or a start that did not go as asked (`error`, like an unknown model swapped
   * for the default one).
   */
  readyCheck?(screen: string): { blocked?: string; error?: string } | undefined;
  /** a turn that settled without doing the work (an API error after the CLI's own retries) */
  turnError(output: string | undefined): string | undefined;
}

/** `model` as pi takes it: a `:level` suffix sets thinking; one already there wins. */
export function withThinking(model: string, thinking?: ThinkingLevel): string {
  if (!thinking || /:(off|minimal|low|medium|high|xhigh|max)$/.test(model)) return model;
  return `${model}:${thinking}`;
}

/** The other CLIs take the level apart from the model: a `:level` suffix is split off and wins. */
export function splitThinking(model: string | undefined, thinking?: ThinkingLevel): { model?: string; thinking?: ThinkingLevel } {
  const match = model ? /^(.*):(off|minimal|low|medium|high|xhigh|max)$/.exec(model) : null;
  return match ? { model: match[1]!, thinking: match[2] as ThinkingLevel } : { model, thinking };
}

/** The last `<pattern>` capture in the output, trimmed. */
function lastMatch(output: string | undefined, pattern: RegExp): string | undefined {
  if (!output) return undefined;
  return [...output.matchAll(pattern)].pop()?.[1]?.trim() || undefined;
}

/**
 * pi prints an exhausted request as a line `Error: <reason>` and ends the turn. A turn that
 * did its work ends with the HANDOFF section the fleet asks for, so an `Error:` line without
 * one is a failed turn; an error quoted inside a real handoff is not.
 */
export function piTurnError(output: string | undefined): string | undefined {
  if (!output || /HANDOFF/.test(output)) return undefined;
  return lastMatch(output, /^\s*Error: (.+?)\s*$/gm);
}

/** A TOML basic string on one line: `-c key=<value>` is how codex takes a config value. */
export function tomlString(text: string): string {
  return JSON.stringify(text).replace(/\x7f/g, "\\u007F");
}

const LOWEST_FIRST = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The CLI's own word for a level: the nearest one it has that is not higher, else its lowest. */
function effortFor(thinking: ThinkingLevel | undefined, levels: Partial<Record<ThinkingLevel, string>>): string | undefined {
  if (!thinking) return undefined;
  const index = LOWEST_FIRST.indexOf(thinking);
  for (let i = index; i >= 0; i--) { const word = levels[LOWEST_FIRST[i]!]; if (word) return word; }
  return Object.values(levels)[0];
}

export const piAdapter: AgentAdapter = {
  kind: "pi",
  instructionsInPrompt: false,
  launchArgs({ model, thinking, tools, name, systemPromptFile }) {
    const args: string[] = [];
    if (model) args.push("--model", withThinking(model, thinking));
    if (tools?.length) args.push("--tools", tools.join(","));
    args.push("--name", `fleet:${name}`, "--append-system-prompt", systemPromptFile);
    return args;
  },
  startupError(screen) {
    return lastMatch(screen, /^\s*Error: (.+)$/gm);
  },
  turnError: piTurnError,
};

/** Claude Code: `--effort` has no off; an unknown model starts anyway and fails at its first request. */
export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  instructionsInPrompt: false,
  launchArgs(options) {
    const { model, thinking } = splitThinking(options.model, options.thinking);
    const effort = effortFor(thinking, { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    return [
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
      "--name", `fleet:${options.name}`,
      "--append-system-prompt-file", options.systemPromptFile,
      "--add-dir", options.resultDir,
    ];
  },
  startupError(screen) {
    return lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm);
  },
  turnError(output) {
    return lastMatch(output, /API Error: ?(.+)$/gm);
  },
};

/** Codex: instructions go in as `developer_instructions`, added to its own rather than replacing them. */
export const codexAdapter: AgentAdapter = {
  kind: "codex",
  instructionsInPrompt: false,
  launchArgs(options) {
    const { model, thinking } = splitThinking(options.model, options.thinking);
    // what codex's models list (model/list) as their efforts: low is the lowest, max only on some
    const effort = effortFor(thinking, { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    return [
      ...(model ? ["--model", model] : []),
      ...(effort ? ["-c", `model_reasoning_effort=${tomlString(effort)}`] : []),
      "-c", `developer_instructions=${tomlString(options.systemPrompt)}`,
      "--add-dir", options.resultDir,
    ];
  },
  startupError(screen) {
    return lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm);
  },
  turnError(output) {
    // codex shows a failed request as a `■ <reason>` line once its retries are spent
    return lastMatch(output, /^\s*■\s+(.+)$/gm);
  },
};

/** Cursor Agent: no instruction option and no level (a model's variants carry it); herdr reports its trust question as idle. */
export const cursorAdapter: AgentAdapter = {
  kind: "cursor",
  instructionsInPrompt: true,
  launchArgs(options) {
    const { model } = splitThinking(options.model, options.thinking);
    return [...(model ? ["--model", model] : []), "--add-dir", options.resultDir];
  },
  startupError(screen) {
    return lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm);
  },
  readyCheck(screen) {
    if (/Workspace Trust Required/.test(screen)) return { blocked: "Cursor Agent asks whether to trust this folder." };
    return undefined;
  },
  turnError(output) {
    return lastMatch(output, /^\s*(?:Error|error): (.+)$/gm);
  },
};

/**
 * Antigravity CLI: no instruction option. herdr reports its trust and sign-in screens as idle, and
 * an unknown model is swapped for the default one with only a warning.
 */
export const agyAdapter: AgentAdapter = {
  kind: "agy",
  instructionsInPrompt: true,
  launchArgs(options) {
    const { model, thinking } = splitThinking(options.model, options.thinking);
    const effort = effortFor(thinking, { low: "low", medium: "medium", high: "high", max: "max" });
    return [
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
      "--add-dir", options.resultDir,
    ];
  },
  startupError(screen) {
    return lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm);
  },
  readyCheck(screen) {
    if (/Do you trust the contents of this project\?/.test(screen)) return { blocked: "Antigravity CLI asks whether to trust this folder." };
    if (/You are currently not signed in/.test(screen)) return { blocked: "Antigravity CLI is not signed in." };
    const unknown = /model (\S+) is not recognized as a known model/.exec(screen);
    if (unknown) return { error: `Unknown model ${unknown[1]}: Antigravity CLI would run its default model instead.` };
    return undefined;
  },
  turnError(output) {
    return lastMatch(output, /^\s*(?:Error|error): (.+)$/gm);
  },
};

const ADAPTERS: Record<AgentKind, AgentAdapter> = { pi: piAdapter, claude: claudeAdapter, codex: codexAdapter, cursor: cursorAdapter, agy: agyAdapter };

export function adapterFor(kind: AgentKind): AgentAdapter {
  return ADAPTERS[kind];
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && Object.hasOwn(ADAPTERS, value);
}
