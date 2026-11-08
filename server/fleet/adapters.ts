import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentKind, ThinkingLevel } from "./types.ts";
import { CLAUDE_ALIASES, listAgyModels, listCodexModels, listCursorModels, listOpencodeModels, listPiModels, type ListOptions, type ModelEntry } from "./model-lists.ts";
import { opencodeConfig, opencodeGitEnv, opencodeReadOnlyNote } from "./opencode-config.ts";
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
  /** the folder the agent works in (a thread's worktree), for a CLI that trusts folders one path at a time */
  cwd: string;
}

/** What the fleet knows when it creates a pane, before the agent starts in it. */
export interface PaneContext {
  /** this run's result folder */
  resultDir: string;
  /** the shell command that runs the fleet CLI */
  fleetCommand: string;
  /** the model as the setting names it, a `:level` suffix included */
  model?: string;
  /** the role edits no file */
  readOnly: boolean;
  /** the role merges for the person (the project's coordinator) */
  merges: boolean;
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
  /** what to tell a role that edits nothing, for a CLI that refuses the commands it may not run without saying which it may */
  readonly readOnlyNote?: (context: Pick<PaneContext, "merges" | "fleetCommand">) => string;
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
  /**
   * The CLI's own list of its models, asked without a model call. `complete`: the list is all the
   * CLI runs, so a model outside it is refused before a run starts; otherwise it is names the CLI
   * accepts among others (aliases, patterns).
   */
  readonly models?: { complete: boolean; list(options: ListOptions): Promise<ModelEntry[]> };
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
  models: { complete: false, list: listPiModels },
  launchArgs({ model, thinking, tools, name, systemPromptFile }) {
    const args: string[] = [];
    if (model) args.push("--model", withThinking(model, thinking));
    if (tools?.length) args.push("--tools", tools.join(","));
    args.push("--name", `fleet:${name}`, "--append-system-prompt", systemPromptFile);
    return args;
  },
  // pi's own denylist: it wins over a --tools list, so a role's tools cannot bring edit or write back
  // codemode (off unless enabled) runs scripts that call other tools, so it goes too
  readOnlyArgs: ["--exclude-tools", "edit,write,codemode"],
  // the input sits between the last two horizontal rules, with no prompt mark: empty, it holds only the cursor (a reverse-video space)
  draft(screen) {
    const lines = stripVTControlCharacters(screen).split(/\r?\n/);
    const rules = lines.flatMap((line, at) => /^─{3,}/.test(line.trim()) ? [at] : []);
    if (rules.length < 2) return false;
    return lines.slice(rules.at(-2)! + 1, rules.at(-1)).join("").trim() !== "";
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
  // no command lists them: the aliases `claude --help` names, and a full name works as well
  models: { complete: false, list: async () => CLAUDE_ALIASES },
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
  models: { complete: true, list: listCodexModels },
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
  models: { complete: true, list: listCursorModels },
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
 * What agy is told to refuse in every mode (`permissions.deny`, which wins over its auto mode's
 * approvals): a force push and a push that deletes a remote branch, as the opencode rules refuse
 * them. Best effort, like those: the shell stays open, and only the usual spellings are matched.
 * A rule is a prefix of the command line, matched word by word, so a flag is refused only right
 * after `git push` (`git push origin x --force` goes through). A `regex:` rule, which the docs
 * describe, refused nothing in agy 1.5.3, not even `regex:git push.*--force.*`; a prefix did.
 */
export const AGY_DENY = ["--force", "--force-with-lease", "--force-if-includes", "-f", "--mirror", "--delete", "-d", "--prune"]
  .map((flag) => `command(git push ${flag})`);

/** an agy model id that names its level, as all in its model list do */
const AGY_MODEL_LEVEL = /-(?:low|medium|high|xhigh|max)$/;

/** The session settings agy is started with in `cwd` (see agyAdapter). */
export function agySettings(cwd: string): Record<string, unknown> {
  return { trustedWorkspaces: [cwd], agentMode: "auto", enableTerminalSandbox: true, permissions: { deny: AGY_DENY } };
}

/**
 * Antigravity CLI: no instruction option. herdr reports its trust, sign-in and approval screens as
 * idle, and an unknown model is swapped for the default one with only a warning.
 *
 * Its settings for the session go in `--settings` (kept for the session, never saved to the person's
 * settings.json, which agy also writes):
 * - `trustedWorkspaces`: agy trusts a folder only by its exact path, a subfolder of a trusted one
 *   included, and asks for each new one, so a thread's new worktree would stop at that question.
 * - `agentMode: "auto"`: edits and safe commands go through, commands that leave the terminal
 *   sandbox are reviewed by a separate agent, irreversible ones are asked. `--mode auto` is decided
 *   before the sign-in is read and falls back to the default mode (agy 1.5.3); the setting is not.
 * - `enableTerminalSandbox`: auto mode needs it.
 * Checked against the real CLI by scripts/agy-live-check.ts.
 */
export const agyAdapter: AgentAdapter = {
  kind: "agy",
  instructionsInPrompt: true,
  models: { complete: true, list: listAgyModels },
  launchArgs(options) {
    const { model, thinking } = splitThinking(options.model, options.thinking);
    // agy's model ids name their level (`gemini-4-argon-medium`): with --effort as well, agy drops
    // the model for its default one (agy 1.5.3), so the id's level stands and the role's goes
    const effort = model && AGY_MODEL_LEVEL.test(model) ? undefined : effortFor(thinking, { low: "low", medium: "medium", high: "high", max: "max" });
    return [
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
      "--add-dir", options.resultDir,
      "--settings", JSON.stringify(agySettings(options.cwd)),
    ];
  },
  // the mode from --settings is set some seconds after the input shows (`auto ·` before the model on
  // its last line): a task typed before would run in the default mode, which asks before every command
  inputReady(screen) {
    return /^\s*>\s*$/m.test(screen) && /\bauto · /.test(screen);
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
    if (unknown) return `Unknown model ${unknown[1]}: Antigravity CLI would run its default model instead.`;
    const conflict = /--model (\S+) conflicts with --effort=(\S+?)\./.exec(screen);
    return conflict ? `The model ${conflict[1]} does not take the level ${conflict[2]}: Antigravity CLI would run its default model instead.` : undefined;
  },
  turnError(output) {
    return lastMatch(output, /^\s*(?:Error|error): (.+)$/gm);
  },
};

/**
 * While it retries a failed request: `⚠ Retrying in 12s · attempt 2 · <reason>` (`⚠ Retry due · ...` once
 * the wait is over), the reason wrapping onto the next line on a narrow pane. A request it gives up on
 * ends in `Error: <reason>`, a blank line and the agent, model and time of the turn (`... · 595ms`):
 * an `Error:` line in a tool's output is not that.
 */
export function opencodeTurnError(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  let found: string | undefined;
  lines.forEach((line, at) => {
    const retry = /^⚠ Retry(?:ing in \S+| due) · attempt \d+ · (.+)$/.exec(line);
    if (retry) {
      const next = lines[at + 1];
      found = next && !next.includes(" · ") && !next.startsWith("┃") ? `${retry[1]} ${next}` : retry[1];
      return;
    }
    const error = /^Error: (.+)$/.exec(line);
    if (error && !/HANDOFF/.test(output) && /^(?:.+ · )?\d[\d.]*m?s$/.test(lines[at + 1] === "" ? lines[at + 2] ?? "" : lines[at + 1] ?? "")) found = error[1];
  });
  return found?.trim() || undefined;
}

const NOT_OPENCODE_2 = "The opencode that herdr starts is not OpenCode 2 (check `opencode --version`); the fleet's rules for it need version 2.";

/**
 * OpenCode 2 (`@opencode/cli`; herdr starts the executable named `opencode`, so that must be version 2).
 * `--standalone` runs its server inside the pane's process, so the pane's environment reaches it
 * (without it the TUI talks to the person's shared background service, started once with whatever
 * environment it had). The TUI has no `--model` or `--agent`: the model, the agent, the rules and the
 * switches come in `OPENCODE_CONFIG_CONTENT` (opencode-config.ts). It updates itself and shares
 * sessions if its config says so; the config turns both off. Plugins stay on: herdr reports its state
 * through one. A model is `provider/model`; a `#variant` the setting carries is passed as written
 * (whether the TUI applies it is not confirmed), and the thinking level is not passed: variants differ per model.
 *
 * The screens were seen on v2.0.26: a new session, a draft, a failed turn, and (the TUI attached to a
 * server whose model is a local script) the permission prompt and the retry line.
 */
export const opencodeAdapter: AgentAdapter = {
  kind: "opencode",
  instructionsInPrompt: true,
  models: { complete: false, list: listOpencodeModels },
  env(context) {
    const { model } = splitThinking(context.model);
    const config = opencodeConfig({ ...context, ...(model ? { model } : {}) });
    return { OPENCODE_DISABLE_AUTOUPDATE: "true", ...opencodeGitEnv(), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  },
  launchArgs() {
    return ["--standalone"];
  },
  // held to it by the config's default agent, not by an argument
  readOnlyArgs: [],
  readOnlyEditsResult: true,
  readOnlyNote: opencodeReadOnlyNote,
  // the input is a box of `┃` rows that ends above a `╹▀▀▀` line: padding, the text, padding, and last the agent and model; empty, it shows a "Ask anything…" placeholder
  draft(screen) {
    const lines = stripVTControlCharacters(screen).split(/\r?\n/).map((line) => line.trim());
    const bottom = lines.map((line, at) => (/^╹▀+/.test(line) ? at : -1)).reduce((last, at) => Math.max(last, at), -1);
    if (bottom < 0) return false;
    let top = bottom;
    while (top > 0 && lines[top - 1]!.startsWith("┃")) top--;
    // text starts two columns after the bar; a toast drawn over the box's right side (`Getting started`) starts far from it
    return lines.slice(top, bottom - 1).some((line) => {
      const text = /^┃ {2}(\S.*)$/.exec(line)?.[1];
      return text !== undefined && !text.startsWith("Ask anything…");
    });
  },
  // herdr starts the executable named `opencode`, which may still be 1.x: it answers --standalone with its help text and exit code 1 (v1.19.0; its TUI is not started, so the screen is that help)
  startupError(screen) {
    return /opencode \[project\]\s+start opencode tui/.test(screen) ? NOT_OPENCODE_2 : lastMatch(screen, /^\s*(?:Error|error): (.+)$/gm);
  },
  question(screen) {
    // the permission request replaces the input; once answered it leaves the screen. Its title is shortened to `Permission` on a narrow pane
    const plain = stripVTControlCharacters(screen);
    return /△ Permission/.test(plain) && /Allow once/.test(plain) && /Reject/.test(plain) ? "OpenCode asks for permission." : undefined;
  },
  turnError(output) {
    return opencodeTurnError(output);
  },
};

const ADAPTERS: Record<AgentKind, AgentAdapter> = { pi: piAdapter, claude: claudeAdapter, codex: codexAdapter, cursor: cursorAdapter, agy: agyAdapter, opencode: opencodeAdapter };

export const AGENT_KINDS = Object.keys(ADAPTERS) as AgentKind[];

export function adapterFor(kind: AgentKind): AgentAdapter {
  return ADAPTERS[kind];
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && Object.hasOwn(ADAPTERS, value);
}
