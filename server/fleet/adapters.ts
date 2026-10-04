import { dirname } from "node:path";
import type { AgentKind, ThinkingLevel } from "./types.ts";
import type { UsageReading } from "./usage.ts";

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
  /** a statusLine command that keeps the session's rate limits for the fleet (Claude Code) */
  statusLineCommand?: string;
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
   * A question on the screen that herdr reports as idle: what it asks. Looked at once the agent is
   * ready and whenever a turn seems to settle, so the run blocks instead of passing for done.
   */
  question?(screen: string): string | undefined;
  /** the screen once herdr calls the agent ready: a start that did not go as asked (an unknown model swapped for the default one) */
  readyError?(screen: string): string | undefined;
  /** herdr calls the CLI ready before it draws its input or its questions: the screen once it has */
  inputReady?(screen: string): boolean;
  /** a turn that settled without doing the work (an API error after the CLI's own retries) */
  turnError(output: string | undefined): string | undefined;
  /** what to type into a settled CLI to show its usage, for a CLI that tells it no other way (cursor) */
  readonly usageCommand?: string;
  /** the usage on that screen, once it shows */
  usageScreen?(screen: string, now: number): UsageReading | undefined;
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

/**
 * The question whose pattern shows last on the screen, after the CLI's last input line: one
 * answered stays in the scrollback above the input drawn after it, and asks nothing any more.
 */
export function openQuestion(screen: string, input: RegExp, questions: Array<[RegExp, string]>): string | undefined {
  const lastIndex = (pattern: RegExp) => {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    return [...screen.matchAll(global)].pop()?.index ?? -1;
  };
  const inputAt = lastIndex(input);
  let open: { at: number; text: string } | undefined;
  for (const [pattern, text] of questions) {
    const at = lastIndex(pattern);
    if (at > inputAt && (!open || at > open.at)) open = { at, text };
  }
  return open?.text;
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

// Every CLI starts in its auto-approval mode: what it judges safe runs, the rest is asked and the
// run blocks for a person. No mode that approves everything.

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
      "--permission-mode", "auto",
      "--name", `fleet:${options.name}`,
      "--append-system-prompt-file", options.systemPromptFile,
      "--add-dir", options.resultDir,
      // a settings layer over the person's: only the statusLine, which feeds the fleet's usage
      ...(options.statusLineCommand ? ["--settings", JSON.stringify({ statusLine: { type: "command", command: options.statusLineCommand } })] : []),
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
      // approvals go to codex's automatic review; commands stay in the workspace-write sandbox
      "--approve-for-me",
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

/** cursor's empty input line */
const CURSOR_INPUT = /Plan, search, build anything/;

/**
 * Cursor Agent: no instruction option and no level (a model's variants carry it). It asks to trust
 * every folder it is given, after herdr already called it ready (which herdr reports as idle).
 */
export const cursorAdapter: AgentAdapter = {
  kind: "cursor",
  instructionsInPrompt: true,
  launchArgs(options) {
    const { model } = splitThinking(options.model, options.thinking);
    // the folder holding every run's result folder: trusted once, not once per run
    return [...(model ? ["--model", model] : []), "--auto-review", "--add-dir", dirname(options.resultDir)];
  },
  inputReady(screen) {
    return CURSOR_INPUT.test(screen);
  },
  startupError(screen) {
    return lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm);
  },
  question(screen) {
    return openQuestion(screen, CURSOR_INPUT, [[/Workspace Trust Required/, "Cursor Agent asks whether to trust this folder."]]);
  },
  turnError(output) {
    return lastMatch(output, /^\s*(?:Error|error): (.+)$/gm);
  },
  usageCommand: "/usage",
  usageScreen: cursorUsage,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * cursor's `/usage` pager: `Included  12% used` (the plan's included usage, which on-demand would
 * extend; off for this fleet's user) and `Resets Oct 23`, a UTC date with no year (the next one),
 * written in the CLI's locale: `Resets 10月26日` under ja_JP.
 */
export function cursorUsage(screen: string, now: number): UsageReading | undefined {
  const included = [...screen.matchAll(/Included:?\s+(\d+(?:\.\d+)?)% used/g)].pop();
  if (!included) return undefined;
  const named = [...screen.matchAll(/Resets (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g)].pop();
  const numeric = [...screen.matchAll(/Resets (\d{1,2})月(\d{1,2})日/g)].pop();
  const date = named ? { month: MONTHS.indexOf(named[1]!), day: Number(named[2]) } : numeric ? { month: Number(numeric[1]) - 1, day: Number(numeric[2]) } : undefined;
  let resetsAt: number | undefined;
  if (date) {
    const year = new Date(now).getUTCFullYear();
    resetsAt = Date.UTC(year, date.month, date.day);
    if (resetsAt <= now) resetsAt = Date.UTC(year + 1, date.month, date.day);
  }
  return { windows: [{ name: "monthly", usedPercent: Number(included[1]), ...(resetsAt ? { resetsAt } : {}) }], readAt: now };
}

/**
 * Antigravity CLI: no instruction option. herdr reports its trust, sign-in and approval screens as
 * idle, and an unknown model is swapped for the default one with only a warning.
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
      // agy has no auto mode: edits go through, commands are asked
      "--mode", "accept-edits",
      "--add-dir", options.resultDir,
    ];
  },
  startupError(screen) {
    return lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm);
  },
  question(screen) {
    // its input is an empty `>` line between rules; a message or an option after `>` is not it
    return openQuestion(screen, /^\s*>\s*$/m, [
      [/Do you trust the contents of this project\?/, "Antigravity CLI asks whether to trust this folder."],
      [/You are currently not signed in/, "Antigravity CLI is not signed in."],
      [/Requesting permission for:/, "Antigravity CLI asks for permission to use a tool."],
    ]);
  },
  readyError(screen) {
    const unknown = /model (\S+) is not recognized as a known model/.exec(screen);
    return unknown ? `Unknown model ${unknown[1]}: Antigravity CLI would run its default model instead.` : undefined;
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
