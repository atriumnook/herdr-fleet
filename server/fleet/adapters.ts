import { basename, dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
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
}

/** What the fleet knows when it creates a pane, before the agent starts in it. */
export interface PaneContext {
  /** this run's result folder */
  resultDir: string;
  /** the shell command that runs the fleet CLI */
  fleetCommand: string;
}

/** What differs between agent CLIs: how one is launched, and how it says it failed. */
export interface AgentAdapter {
  readonly kind: AgentKind;
  /** the CLI takes no instructions at launch: they lead the first prompt instead */
  readonly instructionsInPrompt: boolean;
  /** environment variables for the pane the CLI starts in, for a CLI configured by them (herdr's `agent.start` takes none) */
  env?(context: PaneContext): Record<string, string>;
  /** argv after the executable, for herdr's `agent.start` */
  launchArgs(options: LaunchOptions): string[];
  /** argv that takes the CLI's file-editing tools away, for a role that edits nothing; absent where the CLI cannot be held to that */
  readonly readOnlyArgs?: readonly string[];
  /** under `readOnlyArgs` the CLI's editing tool stays on for the result file alone, so a shell command to write it is not needed (and would be asked) */
  readonly readOnlyEditsResult?: boolean;
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
  /**
   * A draft the person left in the CLI's input, on its screen read with colors: what the fleet
   * types into a settled CLI would join it, so the fleet types nothing then.
   */
  draft?(screen: string): boolean;
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
    ];
  },
  // codex is not: its --approve-for-me overrides a read-only sandbox
  readOnlyArgs: ["--disallowedTools", "Edit,Write,NotebookEdit"],
  startupError(screen) {
    return lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm);
  },
  // the input line opens with ❯ and a no-break space; the placeholder there is dim, a draft is not
  draft(screen) {
    const line = [...screen.matchAll(/^(?:\x1b\[[0-9;]*m)*❯\u00a0(.*)$/gm)].at(-1)?.[1];
    if (line === undefined) return false;
    const text = line.replace(/^(?:\x1b\[0m)+/, "");
    return !text.startsWith("\x1b[2m") && stripVTControlCharacters(text).trim() !== "";
  },
  turnError(output) {
    return lastMatch(output, /API Error: ?(.+)$/gm);
  },
};

/**
 * The workspace-write sandbox blocks the network, the loopback the fleet server listens on too.
 * Codex is told to ask for that one command outside the sandbox, which its automatic review then
 * judges, rather than the network being opened for every command.
 */
const CODEX_FLEET_NOTE = "If a fleet command fails because it cannot reach the fleet server, your sandbox is blocking the local network: request to run that same command outside the sandbox, giving as the reason that it reaches the fleet server on this machine.";

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
      "-c", `developer_instructions=${tomlString(`${options.systemPrompt}\n\n${CODEX_FLEET_NOTE}`)}`,
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

/**
 * The commands opencode may run unasked, each exactly as written: a pattern with a trailing `*` also
 * matches the arguments, and git's `--output=<file>` writes, `--no-index` reads any file, `--ext-diff`
 * and `--textconv` run helpers.
 */
const OPENCODE_READ_ONLY_COMMANDS = ["git status", "git diff", "git log", "git show", "git ls-files", "ls", "pwd"];
const OPENCODE_READ_ONLY_AGENT = "fleet-readonly";
/**
 * Text that turns an allowed command back into an ask, whatever it is allowed by. opencode matches a
 * command that has a redirect by the text of the whole statement, so `ls > ~/x` would match the
 * pattern for `ls *` (see the test); the later rule wins, so these follow the allows.
 */
const OPENCODE_ASK_AFTER = ["*>*", "*<*", "*--output*", "*--no-index*", "*--ext-diff*", "*--textconv*"];

/**
 * opencode has no mode that judges a request: it allows everything by default, and its only other
 * mode (`--auto`) approves every request not denied. So the fleet gives it a permission ruleset of
 * its own (`OPENCODE_PERMISSION`, merged after the person's config; the last matching rule wins):
 * edits go through, a shell command is asked unless it is one of a few read-only commands or the
 * fleet CLI (and has no redirect), and so is the web. The run blocks for a person at each ask.
 */
export function opencodePermission({ resultDir, fleetCommand }: PaneContext): Record<string, unknown> {
  const runFolder = `${basename(dirname(resultDir))}/${basename(resultDir)}`;
  return {
    // the result file lies outside the workspace; edit patterns are paths relative to the worktree, hence the leading `*`
    edit: { [`*/${runFolder}/*`]: "allow" },
    external_directory: { [`${resultDir}/*`]: "allow" },
    bash: {
      "*": "ask",
      ...Object.fromEntries(OPENCODE_READ_ONLY_COMMANDS.map((command) => [command, "allow"])),
      [`${fleetCommand} *`]: "allow",
      ...Object.fromEntries(OPENCODE_ASK_AFTER.map((pattern) => [pattern, "ask"])),
    },
    webfetch: "ask",
    websearch: "ask",
  };
}

/**
 * OpenCode: no instruction option short of a config file, so the instructions lead the first
 * prompt. It updates itself, shares sessions if its config says so and downloads language servers;
 * the pane's environment turns each off. Plugins stay on: herdr reports opencode's state through
 * one. A model is `provider/model`; the TUI takes no thinking level (only `opencode run` has `--variant`).
 */
export const opencodeAdapter: AgentAdapter = {
  kind: "opencode",
  instructionsInPrompt: true,
  env(context) {
    const permission = opencodePermission(context);
    return {
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_SHARE: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      OPENCODE_PERMISSION: JSON.stringify(permission),
      // an agent that edits nothing but the result file: an agent's rules come after the top level's, so its deny is followed by the allow
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        agent: { [OPENCODE_READ_ONLY_AGENT]: { mode: "primary", description: "Reads the repository and edits no file.", permission: { edit: { "*": "deny", ...(permission["edit"] as object) } } } },
      }),
    };
  },
  launchArgs(options) {
    const { model } = splitThinking(options.model, options.thinking);
    return model ? ["--model", model] : [];
  },
  readOnlyArgs: ["--agent", OPENCODE_READ_ONLY_AGENT],
  readOnlyEditsResult: true,
  startupError(screen) {
    return lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm);
  },
  question(screen) {
    // the permission request replaces the input; once answered it leaves the screen
    const plain = stripVTControlCharacters(screen);
    return /Permission required/.test(plain) && /Allow once/.test(plain) ? "OpenCode asks for permission." : undefined;
  },
  turnError(output) {
    // while it retries a failed request opencode shows `<reason> [retrying in 12s attempt #2]`
    return lastMatch(output, /^\s*(.+?) \[retrying (?:in \S+ )?attempt #\d+\]\s*$/gm);
  },
};

const ADAPTERS: Record<AgentKind, AgentAdapter> = { pi: piAdapter, claude: claudeAdapter, codex: codexAdapter, cursor: cursorAdapter, agy: agyAdapter, opencode: opencodeAdapter };

export function adapterFor(kind: AgentKind): AgentAdapter {
  return ADAPTERS[kind];
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && Object.hasOwn(ADAPTERS, value);
}
