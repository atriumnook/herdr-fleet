import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { opencodeGitEnv } from "./opencode-config.ts";
import { AGY_DENY, adapterFor, cursorUsage, type PaneContext, isAgentKind, piTurnError, splitThinking, tomlString, withThinking } from "./adapters.ts";
import { rateLimitUntil } from "./usage.ts";

const base = { name: "impl", systemPromptFile: "/tmp/i.md", systemPrompt: "Be brief.\nSay \"done\".", resultDir: "/state/results/r1", cwd: "/repo/.herdr-fleet/worktrees/t1" };

describe("pi adapter", () => {
  const pi = adapterFor("pi");

  it("launches with the model at its thinking level, the role's tools, a fleet name and the instruction file", () => {
    expect(pi.launchArgs({ ...base, model: "p/m", thinking: "low", tools: ["read", "bash"] }))
      .toEqual(["--model", "p/m:low", "--tools", "read,bash", "--name", "fleet:impl", "--append-system-prompt", "/tmp/i.md"]);
    expect(pi.launchArgs(base)).toEqual(["--name", "fleet:impl", "--append-system-prompt", "/tmp/i.md"]);
    expect(pi.instructionsInPrompt).toBe(false);
  });

  it("keeps a :level the model already carries", () => {
    expect(withThinking("p/m:high", "low")).toBe("p/m:high");
    expect(withThinking("p/m")).toBe("p/m");
  });

  it("calls a turn failed by its last Error: line only when no HANDOFF follows", () => {
    expect(piTurnError("working...\nError: 401 unauthorized\n")).toBe("401 unauthorized");
    expect(piTurnError("Error: first\nmore\nError: second")).toBe("second");
    expect(piTurnError("Error: test failed earlier\nHANDOFF\noutcome: fixed")).toBeUndefined();
    expect(piTurnError(undefined)).toBeUndefined();
  });
});

describe("claude adapter", () => {
  const claude = adapterFor("claude");

  it("appends the instruction file, names the session and lets the agent write its result folder", () => {
    expect(claude.launchArgs({ ...base, model: "opus", thinking: "high", tools: ["read"] })).toEqual([
      "--model", "opus", "--effort", "high", "--permission-mode", "auto", "--name", "fleet:impl", "--append-system-prompt-file", "/tmp/i.md", "--add-dir", "/state/results/r1",
    ]);
    expect(claude.instructionsInPrompt).toBe(false);
  });

  it("takes a :level suffix as the effort, and has no level below low", () => {
    expect(claude.launchArgs({ ...base, model: "sonnet:xhigh", thinking: "low" }).slice(0, 4)).toEqual(["--model", "sonnet", "--effort", "xhigh"]);
    expect(claude.launchArgs({ ...base, thinking: "off" }).slice(0, 2)).toEqual(["--effort", "low"]);
  });

});

describe("pi adapter", () => {
  const pi = adapterFor("pi");

  it("takes edit, write and codemode away from a role that edits no file", () => {
    expect(pi.readOnlyArgs).toEqual(["--exclude-tools", "edit,write,codemode"]);
  });

});

describe("codex adapter", () => {
  const codex = adapterFor("codex");

  it("passes the instructions as developer_instructions on one argv line, and the level as reasoning effort", () => {
    const args = codex.launchArgs({ ...base, model: "gpt-5.5", thinking: "max" });
    expect(args).toEqual([
      "--model", "gpt-5.5", "-c", 'model_reasoning_effort="max"', "-c", expect.stringMatching(/^developer_instructions="Be brief\.\\nSay \\"done\\"\.\\n\\n/), "-c", "notice.hide_rate_limit_model_nudge=true", "-c", 'tui.status_line=["model-with-reasoning","current-dir"]', "--approve-for-me", "--add-dir", "/state/results/r1",
    ]);
    expect(args.some((arg) => arg.includes("\n"))).toBe(false);
  });

  it("tells codex to ask for a fleet command outside its sandbox when the sandbox keeps it from the fleet server", () => {
    const instructions = codex.launchArgs(base).find((arg) => arg.startsWith("developer_instructions="))!;
    expect(instructions).toContain("request to run that same command outside the sandbox");
    // the network stays shut for every other command: no config opens it
    expect(codex.launchArgs(base).join(" ")).not.toContain("network_access");
  });

  it("runs the lowest level as low, the lowest effort codex's models take", () => {
    expect(codex.launchArgs({ ...base, thinking: "off" }).slice(0, 2)).toEqual(["-c", 'model_reasoning_effort="low"']);
    expect(codex.launchArgs({ ...base, thinking: "minimal" }).slice(0, 2)).toEqual(["-c", 'model_reasoning_effort="low"']);
  });

  // codex-rs tui/src/chatwidget/rate_limits.rs: near the limit codex opens a selection whose first
  // item switches to another model, and the Enter the fleet sends after a message would choose it
  it("starts codex with its rate-limit model switch prompt hidden, as a launch value rather than in the person's config", () => {
    const args = codex.launchArgs(base);
    const at = args.indexOf("notice.hide_rate_limit_model_nudge=true");
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe("-c");
  });

  // the notice as codex-rs tui/src/app/backend_banner_fallback.rs writes it, after its "• " bullet
  const SWITCHED = "• Automatically switched to Luna Reserve medium due to usage limits.";

  it("fails a turn whose screen says codex switched models by itself on usage limits, report or not", () => {
    const screen = `› Fix the bug\n\n${SWITCHED}\n\n› Ask Codex to do anything\n\n  Luna Reserve medium · ~/repo`;
    expect(codex.modelSwitch?.(screen)).toBe("Automatically switched to Luna Reserve medium due to usage limits.");
    expect(codex.turnError(screen)).toBe("Automatically switched to Luna Reserve medium due to usage limits.");
    // the fleet's cooldown takes it for a usage limit
    expect(rateLimitUntil(codex.turnError(screen)!)).toBeUndefined();
    // wrapped in a narrow pane, with colors
    expect(codex.modelSwitch?.("\x1b[2m• \x1b[0mAutomatically switched to Luna Reserve\nmedium due to usage limits.\n")).toBe("Automatically switched to Luna Reserve medium due to usage limits.");
  });

  // codex-rs tui/src/chatwidget/status_surfaces.rs: the status line under the input names the model in use
  it("starts codex with a status line that opens with the model in use, so the fleet can read it off the screen", () => {
    const args = codex.launchArgs(base);
    expect(args[args.indexOf('tui.status_line=["model-with-reasoning","current-dir"]') - 1]).toBe("-c");
  });

  it("takes the switch notice for an answer that quotes it when the status line still shows another model", () => {
    // an assistant message opens with the same dim bullet as the notice (codex-rs AgentMarkdownCell)
    expect(codex.modelSwitch?.(`› What does codex say on a usage limit?\n\n${SWITCHED}\n\n› Ask Codex to do anything\n\n  GPT-5.5 high · ~/repo`)).toBeUndefined();
    // the status line names a model by its catalog name (models-manager/models.json), the notice by its slug
    expect(codex.modelSwitch?.("• Automatically switched to gpt-6.1-terra medium due to usage limits.\n\n› Ask Codex to do anything\n\n  GPT-6.1 Terra medium · ~/repo")).toBe("Automatically switched to gpt-6.1-terra medium due to usage limits.");
  });

  it("takes the switch notice for a quoted one while the status line shows the model the fleet asked for", () => {
    // the quote names the model in use: only the model asked for at launch tells it from a real switch
    const quoted = "• Automatically switched to gpt-6.1-terra medium due to usage limits.\n\n› Ask Codex to do anything\n\n  GPT-6.1 Terra medium · ~/repo";
    expect(codex.modelSwitch?.(quoted, "gpt-6.1-terra:medium")).toBeUndefined();
    expect(codex.turnError(quoted, "gpt-6.1-terra")).toBeUndefined();
    expect(codex.modelSwitch?.(quoted, "gpt-5.5")).toBe("Automatically switched to gpt-6.1-terra medium due to usage limits.");
    // gpt-6.1 is not gpt-6.1-terra
    expect(codex.modelSwitch?.(quoted, "gpt-6.1")).toBe("Automatically switched to gpt-6.1-terra medium due to usage limits.");
  });

  it("fails a turn whose status line shows the reserve model, once the switch notice scrolled out of what the fleet reads", () => {
    const failure = codex.modelSwitch?.("• Fixed it and ran the tests.\n\n› Ask Codex to do anything\n\n  Luna Reserve medium · ~/repo\n\n");
    expect(failure).toBe("codex runs on Luna Reserve medium, the reserve model it switches to by itself on usage limits");
    expect(rateLimitUntil(failure!)).toBeUndefined();
    expect(codex.modelSwitch?.("• Fixed it.\n\n› Ask Codex to do anything\n\n  gpt-reserve low · ~/repo")).toBe("codex runs on gpt-reserve low, the reserve model it switches to by itself on usage limits");
    expect(codex.modelSwitch?.("• Fixed it.\n\n› Ask Codex to do anything\n\n  GPT-5.5 high · ~/repo")).toBeUndefined();
  });

  // codex-rs tui/src/chatwidget/backend_banners.rs refresh_backend_banner_visibility: on its first switch to the
  // reserve model codex opens this picker where the input and status line were (luna_reserve_usage_with_upsell.snap)
  it("fails a turn left at codex's reserve picker, which hides the status line, once the switch notice scrolled out", () => {
    const picker = [
      "• Fixed it and ran the tests.", "",
      "  You’re now using Luna, a faster model for simpler tasks.",
      "  Add credits or upgrade to continue using the most advanced models.", "", "",
      "› 1. Add credits", "  2. Upgrade", "  3. Continue with Luna Reserve", "",
      "  Press enter to confirm or esc to continue working", "",
    ].join("\n");
    expect(codex.modelSwitch?.(picker, "gpt-5.5")).toBe("codex runs on Luna Reserve, the reserve model it switches to by itself on usage limits");
    // the item quoted in an answer is no picker
    expect(codex.modelSwitch?.("• The picker offers 3. Continue with Luna Reserve\n\n› Ask Codex to do anything\n\n  GPT-5.5 high · ~/repo", "gpt-5.5")).toBeUndefined();
  });

  it("reads a real switch notice under a quote of one that names another model", () => {
    const screen = "• Automatically switched to gpt-5.6-terra medium due to usage limits.\n\n• Fixed it.\n\n• Automatically switched to gpt-6-luna low due to usage limits.\n\n• Automatically switched back to gpt-6-sol high because ordinary usage is available again.\n\n› Ask Codex to do anything\n\n  GPT-5.6-Terra medium · ~/repo";
    expect(codex.modelSwitch?.(screen, "gpt-5.5")).toBe("Automatically switched to gpt-5.6-terra medium due to usage limits.");
  });

  it("does not fail a turn once codex switched back, or on the notice's words quoted in a message", () => {
    expect(codex.modelSwitch?.(`${SWITCHED}\n\n• Automatically switched back to gpt-5.5 high because ordinary usage is available again.\n`)).toBeUndefined();
    expect(codex.modelSwitch?.("› If the screen says 'Automatically switched to … due to usage limits.', treat it as a failure\n")).toBeUndefined();
    expect(codex.modelSwitch?.("› Read the notice\n  Automatically switched to Luna Reserve medium due to usage limits.\n")).toBeUndefined();
    expect(codex.turnError("■ stream disconnected before completion")).toBe("stream disconnected before completion");
  });

  it("escapes what a TOML basic string cannot hold raw", () => {
    expect(tomlString("a\tb\\c\u0001\u007f")).toBe('"a\\tb\\\\c\\u0001\\u007F"');
  });

});

describe("cursor adapter", () => {
  const cursor = adapterFor("cursor");

  it("is given the folder of all result folders, so it asks to trust one folder once rather than one per run", () => {
    expect(cursor.launchArgs(base).at(-1)).toBe("/state/results");
  });

  it("has no instruction option or level: the instructions lead the first prompt", () => {
    expect(cursor.launchArgs({ ...base, model: "gpt-5:high", thinking: "low" })).toEqual(["--model", "gpt-5", "--auto-review", "--add-dir", "/state/results"]);
    expect(cursor.instructionsInPrompt).toBe(true);
  });

});

describe("cursor usage", () => {
  // as cursor-agent 2026.09.23 draws its /usage pager (src/components/usage-pager.tsx)
  const pager = [
    "Usage · Pro                                        Resets Oct 23",
    "Monthly plan and on-demand usage",
    "Category        Current         Usage",
    "Included        12% used        ███░░░░░░░░░░░░░░░░░",
    "  Auto          10% used        ██░░░░░░░░░░░░░░░░░░",
    "  API           2% used         █░░░░░░░░░░░░░░░░░░░",
    "On-Demand       Disabled        ————————————————————",
    "On-demand usage is off",
  ].join("\n");
  const now = Date.parse("2026-10-04T07:00:00Z");

  it("is typed as /usage and read as the included share, until the next reset date", () => {
    expect(adapterFor("cursor").usageCommand).toBe("/usage");
    expect(cursorUsage(pager, now)).toEqual({ readAt: now, windows: [{ name: "monthly", usedPercent: 12, resetsAt: Date.parse("2026-10-23T00:00:00Z") }] });
  });

  it("reads the pager as cursor-agent 2026.09.23 drew it under ja_JP", () => {
    // captured from a live pane (`/usage` typed into cursor-agent; Esc closed it)
    const live = [
      "────────────────────────────────────────────────",
      " Usage • Pro                                    Resets 10月26日",
      " Monthly plan and on-demand usage",
      " Category        Current             Usage",
      " Included        1% used             █░░░░░░░░░░░░░░░░░░░░",
      "   Auto          0% used             ░░░░░░░░░░░░░░░░░░░░░",
      "   API           1% used             █░░░░░░░░░░░░░░░░░░░░",
      " On-Demand       Disabled            ———————————————————————",
      " On-demand usage is off",
      " View in dashboard: cursor.com/dashboard?tab=usage",
      " Esc to close",
    ].join("\n");
    expect(cursorUsage(live, now)).toEqual({ readAt: now, windows: [{ name: "monthly", usedPercent: 1, resetsAt: Date.parse("2026-10-26T00:00:00Z") }] });
  });

  it("reads the narrow layout, a reset date in the next year, and nothing before the pager shows", () => {
    const narrow = "Usage · Pro\nResets Jan 2\nIncluded: 97% used\nAuto: 90% used";
    expect(cursorUsage(narrow, Date.parse("2026-12-20T00:00:00Z"))!.windows).toEqual([{ name: "monthly", usedPercent: 97, resetsAt: Date.parse("2027-01-02T00:00:00Z") }]);
    expect(cursorUsage("Loading usage data...", now)).toBeUndefined();
  });
});

describe("agy adapter", () => {
  const agy = adapterFor("agy");

  it("takes the model and effort, with instructions in the first prompt, and every run's results folder (a reviewer reads its lead's)", () => {
    expect(agy.launchArgs({ ...base, model: "gemini-3.8-pro", thinking: "xhigh" }).slice(0, 6)).toEqual(["--model", "gemini-3.8-pro", "--effort", "high", "--add-dir", "/state/results"]);
    expect(agy.instructionsInPrompt).toBe(true);
  });

  it("leaves the level to a model id that names one, as agy drops such a model given --effort as well", () => {
    expect(agy.launchArgs({ ...base, model: "gemini-4-argon-medium", thinking: "high" }).slice(0, 3)).toEqual(["--model", "gemini-4-argon-medium", "--add-dir"]);
    expect(agy.launchArgs({ ...base, model: "claude-sonnet-5-5-low:max" }).slice(0, 3)).toEqual(["--model", "claude-sonnet-5-5-low", "--add-dir"]);
    expect(agy.launchArgs({ ...base, thinking: "high" }).slice(0, 2)).toEqual(["--effort", "high"]);
  });

  it("trusts the run's own folder and runs in auto mode in the sandbox, for the session only", () => {
    const args = agy.launchArgs(base);
    expect(args).not.toContain("--mode");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings).toEqual({ trustedWorkspaces: ["/repo/.herdr-fleet/worktrees/t1"], agentMode: "auto", enableTerminalSandbox: true, permissions: { deny: AGY_DENY } });
  });

  it("refuses a force push and a push that deletes a remote branch, and lets an ordinary push through", () => {
    // agy matches a command rule as a prefix of the command line, word by word
    const words = AGY_DENY.map((rule) => /^command\((.*)\)$/.exec(rule)![1]!.split(" "));
    const refused = (line: string) => words.some((rule) => rule.every((word, i) => line.split(/\s+/)[i] === word));
    for (const line of ["git push --force origin main", "git push -f origin x", "git push --force-with-lease", "git push --mirror", "git push --delete origin x", "git push -d origin x", "git push --prune origin"]) expect(refused(line)).toBe(true);
    for (const line of ["git push", "git push -u origin fleet/t1", "git push origin HEAD:refs/heads/x", "git status --force", "git pushd -f"]) expect(refused(line)).toBe(false);
  });

  const screen = (name: string) => readFileSync(join(import.meta.dir, "../../fixtures/screens/agy", name, "screen.txt"), "utf8");
  const QUOTA = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 75h7m14s.";

  it("fails a turn that ended on the quota warning, wrapped onto the next lines or not, and not one the agent worked on after it", () => {
    expect(agy.turnError(screen("ends-the-turn-on-individual-quota-reached-1"))).toBe(QUOTA);
    const wrapped = "● Explored 2 files\n\n⚠ Individual quota reached. Please upgrade your subscription to\n  increase your limits. Resets in 75h7m14s.\nError ID: abc-43\n\n──────\n>\n──────\n? for shortcuts    auto · Gemini 4 Argon · high";
    expect(agy.turnError(wrapped)).toBe(QUOTA);
    // a later turn ran: the warning is the scrollback of an earlier one
    const after = `⚠ ${QUOTA}\nError ID: abc-43\n\n──────\n> go on\n\n● Explored 2 files\n\n──────\n>\n──────\n? for shortcuts`;
    expect(agy.turnError(after)).toBeUndefined();
  });

  it("names a file access screen as one nobody answers, with the file it asks for, and nothing else", () => {
    const reason = agy.unanswerable?.(screen("asks-to-read-a-skill-outside-the-workspace-1"));
    expect(reason).toContain("/home/someone/.claude/skills/clarify-ja/SKILL.md");
    expect(reason).toContain("outside its workspace");
    expect(agy.unanswerable?.(screen("asks-to-read-a-file-outside-the-workspace-1"))).toContain("/elsewhere/note.txt");
    // asked, answered and the input drawn again: nothing is open
    expect(agy.unanswerable?.(`${screen("asks-to-read-a-skill-outside-the-workspace-1")}\n● Explored 1 file\n\n──────\n>\n──────\n? for shortcuts`)).toBeUndefined();
    expect(agy.unanswerable?.("Requesting permission for:\n  rm -rf build\nRun this command?")).toBeUndefined();
  });

});

describe("opencode adapter", () => {
  const opencode = adapterFor("opencode");
  const fleet = "/usr/bin/bun /opt/fleet/bin/fleet.ts";
  const resultDir = "/state/fleet-results/r1";
  const pane: PaneContext = { resultDir, fleetCommand: fleet, readOnly: false, merges: false };
  const readOnlyPane = { ...pane, readOnly: true };
  const coordinatorPane = { ...readOnlyPane, merges: true };
  const configOf = (context: typeof pane) => JSON.parse(opencode.env!(context)["OPENCODE_CONFIG_CONTENT"]!) as {
    model?: string; share?: string; update?: string; default_agent?: string; plugins?: Array<{ package: string; options: unknown }>;
    permissions?: Rule[]; agents?: Record<string, { mode: string; permissions: Rule[] }>;
  };
  type Rule = { action: string; resource: string; effect: string };

  /**
   * OpenCode 2.0.26, packages/core/src: `Wildcard.match` (util/wildcard.ts) and `Permission.evaluate`
   * (permission.ts), as they are. A request is denied when any of its resources is denied by the last
   * rule that matches it (`denied`); else it asks if any resource has no allow as its last match.
   */
  const wildcard = (input: string, pattern: string) => {
    let source = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
    return new RegExp(`^${source}$`, "s").test(input.replaceAll("\\", "/"));
  };
  const evaluate = (action: string, resource: string, rules: Rule[]) =>
    [...rules].reverse().find((rule) => wildcard(action, rule.action) && wildcard(resource, rule.resource))?.effect ?? "ask";
  const decide = (rules: Rule[], action: string, ...resources: string[]) => {
    if (resources.some((resource) => evaluate(action, resource, rules) === "deny")) return "deny";
    return resources.some((resource) => evaluate(action, resource, rules) === "ask") ? "ask" : "allow";
  };
  /** what OpenCode puts before a config's rules for a primary agent of the config (read from /api/agent of the real binary) */
  const SCHEMA_DEFAULT: Rule[] = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
  ];
  const readOnlyRules = (context = readOnlyPane) => [...SCHEMA_DEFAULT, ...configOf(context).agents!["fleet-readonly"]!.permissions];
  const editorRules = (before: Rule[] = []) => [...SCHEMA_DEFAULT, ...before, ...configOf(pane).permissions!];
  /** the verdict for a shell line, given the commands the scanner finds in it (tree-sitter, one resource each; a redirected one as the whole statement) */
  const shell = (rules: Rule[], ...commands: string[]) => decide(rules, "shell", ...commands);

  it("starts the TUI standalone and takes everything else in its config: no model flag, no thinking level, instructions in the first prompt", () => {
    expect(opencode.launchArgs({ ...base, model: "anthropic/claude-sonnet-5-5", thinking: "high" })).toEqual(["--standalone"]);
    expect(opencode.launchArgs(base)).toEqual(["--standalone"]);
    expect(opencode.instructionsInPrompt).toBe(true);
    expect(opencode.readOnlyArgs).toEqual([]);
    expect(opencode.readOnlyEditsResult).toBe(true);
  });

  it("gives the pane the model, no self-update and no sharing, and none of the switches version 2 dropped", () => {
    const env = opencode.env!({ ...pane, model: "anthropic/claude-sonnet-5-5:low" });
    expect(Object.keys(env).sort()).toEqual(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_AUTOUPDATE"]);
    expect(env["OPENCODE_DISABLE_AUTOUPDATE"]).toBe("true");
    // every git of the agent runs without the repository's fsmonitor program (environment config beats the repository's: checked with git 2.55)
    expect([env["GIT_CONFIG_COUNT"], env["GIT_CONFIG_KEY_0"], env["GIT_CONFIG_VALUE_0"]]).toEqual(["1", "core.fsmonitor", "false"]);
    // config the server's own environment carries stays, and ours comes after it
    expect(opencodeGitEnv({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1", GIT_CONFIG_KEY_1: "c.d", GIT_CONFIG_VALUE_1: "2" })).toEqual({
      GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1", GIT_CONFIG_KEY_1: "c.d", GIT_CONFIG_VALUE_1: "2", GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_2: "core.fsmonitor", GIT_CONFIG_VALUE_2: "false",
    });
    expect(opencodeGitEnv({ GIT_CONFIG_COUNT: "x" })["GIT_CONFIG_COUNT"]).toBe("1");
    expect(JSON.parse(env["OPENCODE_CONFIG_CONTENT"]!)).toMatchObject({ model: "anthropic/claude-sonnet-5-5", share: "disabled", update: "disable" });
    // a #variant stays with the model; none given, none set
    expect(configOf({ ...pane, model: "p/m#high" }).model).toBe("p/m#high");
    expect(configOf(pane).model).toBeUndefined();
    // the config text is read with {env:...} and {file:...} substituted
    expect(opencode.env!(pane)["OPENCODE_CONFIG_CONTENT"]).not.toMatch(/\{(env|file):/);
  });

  it("never writes an ask, and never allows everything", () => {
    for (const context of [pane, readOnlyPane, coordinatorPane]) {
      const config = configOf(context);
      const rules = [...(config.permissions ?? []), ...Object.values(config.agents ?? {}).flatMap((agent) => agent.permissions)];
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.some((rule) => rule.effect === "ask")).toBe(false);
      expect(rules.some((rule) => rule.effect === "allow" && rule.action === "*")).toBe(false);
    }
  });

  describe("a role that edits nothing", () => {
    it("is the default agent, with its rules and the guard plugin of this pane alone", () => {
      const config = configOf(readOnlyPane);
      expect(config.default_agent).toBe("fleet-readonly");
      expect(config.agents!["fleet-readonly"]!.mode).toBe("primary");
      expect(config.permissions).toBeUndefined();
      expect(config.agents!["fleet-readonly"]!.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
      expect(config.plugins).toHaveLength(1);
      expect(config.plugins![0]!.package.endsWith("/opencode/fleet-guard")).toBe(true);
      expect(existsSync(`${config.plugins![0]!.package}/index.js`)).toBe(true);
      // the guard is told the fleet command, and whether this role merges
      expect(config.plugins![0]!.options).toEqual({ fleetCommand: fleet, merges: false });
      expect(configOf(coordinatorPane).plugins![0]!.options).toEqual({ fleetCommand: fleet, merges: true });
      const editing = configOf(pane);
      expect(editing.default_agent).toBeUndefined();
      expect(editing.agents).toBeUndefined();
      expect(editing.plugins).toBeUndefined();
    });

    it("reads, searches and runs the short list of read-only commands and the fleet command", () => {
      const rules = readOnlyRules();
      for (const action of ["read", "glob", "grep"]) expect(decide(rules, action, "src/a.ts")).toBe("allow");
      for (const text of ["ls", "pwd", "git status", "git ls-files", `${fleet} list`, `${fleet} send lead "go"`, `${fleet} send lead 'a; b'`, "gh pr view 5 --json title", "gh pr list", "gh pr checks 5", "gh run view 99 --log-failed"]) expect(shell(rules, text)).toBe("allow");
      for (const command of ["diff", "log", "show"]) expect(shell(rules, `git ${command} --no-ext-diff --no-textconv HEAD~1 -- src/a.ts`)).toBe("allow");
      // comments and trailing separators leave the same command nodes
      expect(shell(rules, "ls")).toBe("allow");
    });

    it("refuses what it does not list, the web, a subagent, and a .env file", () => {
      const rules = readOnlyRules();
      for (const text of ["rm -rf build", "cat src/a.ts", "ls -la", "git status --short", "git push", "git commit -m x", "git diff", "git log", "git show HEAD", "git diff HEAD~1", "git log -1", "bun test", "FOO=1 ls", "env ls", "bash -c ls", "eval ls", "xargs rm", "git -C /etc status", "gh pr merge 5 --merge", "gh pr create", "gh api /user"]) expect(shell(rules, text)).toBe("deny");
      for (const action of ["webfetch", "websearch", "subagent", "skill", "execute", "task", "lsp"]) expect(decide(rules, action, "*")).toBe("deny");
      expect(decide(rules, "read", ".env")).toBe("deny");
      expect(decide(rules, "read", "config/.env.local")).toBe("deny");
      expect(decide(rules, "read", ".env.example")).toBe("allow");
      // a file outside the work folder is asked as an external directory first
      expect(decide(rules, "external_directory", "/etc/*")).toBe("deny");
    });

    it("refuses a second command, a substitution or a redirect that comes with a listed one", () => {
      const rules = readOnlyRules();
      expect(shell(rules, "ls", "rm -rf ~")).toBe("deny"); // ls; rm -rf ~   (also &&, ||, |, &, a newline, (..), {..;})
      expect(shell(rules, "ls $(rm x)", "rm x")).toBe("deny");
      for (const text of ["ls > ~/y", "ls >> f", "ls >| f", "ls 3>f", "ls 2>&1", "git status > f", "git show HEAD:f > ~/.bashrc", "cat < /etc/passwd", "gh pr view 5 --json a > f", "git log --no-ext-diff --no-textconv > f"]) expect(shell(rules, text)).toBe("deny");
      // the fleet command takes quoted text that may hold < and >, so the rules let it through; the guard parses its quotes
      expect(shell(rules, `${fleet} send lead "a -> b"`)).toBe("allow");
      // a redirect with no command in it, an assignment and a declaration are not checked at all by OpenCode: the guard refuses them (opencode-guard.test.ts)
    });

    it("lets git history through only in the form that runs no helper and writes no file", () => {
      const rules = readOnlyRules();
      const history = (tail: string) => shell(rules, `git diff --no-ext-diff --no-textconv ${tail}`);
      expect(history("main...HEAD")).toBe("allow");
      expect(history("HEAD~3 -- src")).toBe("allow");
      // two paths outside the repository make git diff an implicit --no-index
      for (const tail of ["/dev/null /etc/passwd", "~/.ssh/id_ed25519", "../outside", "..", "--stat=/x", "HEAD -- ../x"]) expect([tail, history(tail)]).toEqual([tail, "deny"]);
      for (const flag of ["--output=/tmp/x", "--output /tmp/x", "--no-index a b", "--ext-diff", "--textconv"]) expect(history(flag)).toBe("deny");
      // the shell drops quotes, backslashes and expansions before git reads the line
      for (const tail of [`--ex""t-diff`, `--ex''t-diff`, "--ext$X-diff", "--ext`true`-diff", "--ext{-diff,}", `"--output=/tmp/x"`]) expect(history(tail)).toBe("deny");
      // git takes no abbreviation of those options (checked: git 2.x refuses `--ext-d`, `--outp`), so the plain spellings are what to deny
      expect(shell(readOnlyRules(), "git log --no-ext-diff --no-textconv --oneline -n 20")).toBe("allow");
      expect(shell(readOnlyRules(), "git show --no-ext-diff --no-textconv HEAD:src/a.ts")).toBe("allow");
    });

    it("edits only its result file: that path, and its folder as an external directory", () => {
      const rules = readOnlyRules();
      expect(decide(rules, "edit", `${resultDir}/handoff.md`)).toBe("allow");
      expect(decide(rules, "external_directory", `${resultDir}/*`)).toBe("allow");
      expect(decide(rules, "edit", "src/a.ts")).toBe("deny");
      expect(decide(rules, "edit", "/etc/passwd")).toBe("deny");
      // the folder of another run
      expect(decide(rules, "edit", "/state/fleet-results/r10/handoff.md")).toBe("deny");
      expect(decide(rules, "external_directory", "/state/fleet-results/r10/*")).toBe("deny");
    });

    it("merges only when it is the project's coordinator, and only the forms the fleet asks for", () => {
      const merges = ["gh pr merge 12 --merge", "git pull --ff-only", "git merge --no-ff fleet/ab12cd", "git merge --no-ff agents/worker-ab12", "git merge --abort"];
      for (const text of merges) {
        expect(shell(readOnlyRules(coordinatorPane), text)).toBe("allow");
        expect(shell(readOnlyRules(), text)).toBe("deny");
      }
      const rules = readOnlyRules(coordinatorPane);
      for (const text of ["gh pr merge 12 --merge --admin", "gh pr merge --admin --merge", "gh pr merge -d --merge", "gh pr merge 12 -d --merge", "gh pr merge 12 --squash", "gh pr merge 12", "git pull", "git pull --ff-only origin x", "git merge main", "git merge --no-ff main", "git merge --no-ff fleet/x main", "git merge --no-ff fleet/x -s ours", "git merge --no-ff fleet/x -F /etc/passwd", "git push", "git merge --no-ff fleet/x > f", `git merge --no-ff fleet/x"y"`, "git checkout main"]) expect(shell(rules, text)).toBe("deny");
    });

    it("lets the coordinator revert, push the base branch and take a gate's pinned merge, in those forms only", () => {
      const forms = ["gh pr merge 12 --merge --match-head-commit c0ffee1", "git revert -m 1 --no-edit abc0001", "git revert --abort", "git push origin main", "git push origin release/2.0"];
      for (const text of forms) {
        expect([text, shell(readOnlyRules(coordinatorPane), text)]).toEqual([text, "allow"]);
        expect([text, shell(readOnlyRules(), text)]).toEqual([text, "deny"]);
      }
      const rules = readOnlyRules(coordinatorPane);
      for (const text of [
        "gh pr merge 12 --merge --match-head-commit c0ffee1 --admin", "gh pr merge 12 --merge --match-head-commit c0ffee1 -R evil/repo", "gh pr merge -d --merge --match-head-commit c0ffee1",
        "git revert -m 1 --no-edit abc0001 def0002", "git revert -m 1 --no-edit abc0001 -X theirs", "git revert -m 1 --no-edit --no-commit", "git revert abc0001", "git revert --continue",
        "git push origin main --force", "git push origin main -f", "git push origin +main", "git push origin main:main", "git push origin :main", "git push origin -d main", "git push origin --delete main",
        "git push origin HEAD", "git push origin main other", "git push evil main", "git push --force origin main", "git push origin main > f", "git push origin ../x",
        // the bare forms (a trailing pattern ` *` matches them too), and a range or a `..` in a branch name
        "git push origin", "git revert -m 1 --no-edit", "gh pr merge 12 --merge --match-head-commit", "git push origin main/..", "git push origin a..b", "git revert -m 1 --no-edit abc0001..def0002",
      ]) expect([text, shell(rules, text)]).toEqual([text, "deny"]);
    });
  });

  describe("a role that edits", () => {
    it("keeps the defaults, and the person's own denies", () => {
      const rules = editorRules();
      for (const text of ["bun test", "git commit -m x", "git push origin feat/x", "git push -u origin feat/x", "rm -rf build"]) expect(shell(rules, text)).toBe("allow");
      const personal: Rule[] = [{ action: "shell", resource: "*", effect: "ask" }, { action: "shell", resource: "rm *", effect: "deny" }];
      expect(shell(editorRules(personal), "rm -rf x")).toBe("deny");
      expect(shell(editorRules(personal), "bun test")).toBe("ask");
      // its fleet command still gets through a shell that asks
      expect(shell(editorRules(personal), `${fleet} send architect "q"`)).toBe("allow");
    });

    it("refuses a push that overwrites the remote, in the forms git takes it", () => {
      const rules = editorRules();
      for (const text of [
        "git push --force", "git push --force origin main", "git push origin main --force", "git push --force-with-lease", "git push --force-if-includes origin x", "git push origin x --force-with-lease=x:abc",
        "git push -f", "git push -f origin main", "git push origin main -f", "git push -fu origin main", "git push -uf origin main", "git push -nf origin x",
        "git push -vuf origin x", "git push -nvf origin x", "git push --mir", "git push --pru origin", "git push --prun origin", "git push --mirror", "git push --del origin main", "git push --delete origin main", "git push -d origin main", "git push origin :main", "git push --prune origin",
        "git push origin +main", "git push +main", "git push origin +HEAD:main", "git -C ../wt push -f", "git -c push.default=current push --force",
      ]) expect([text, shell(rules, text)]).toEqual([text, "deny"]);
      for (const text of ["git push", "git push origin main", "git push -u origin fix-foo", "git push origin HEAD:refs/heads/a-f", "git push --follow-tags", "git push origin feat/x-fix", "git stash push", "git push -u origin feat/x", "git push --dry-run origin x", "git push -u fork feat/x", "git push -u fork", "git push -v fork main", "git push -n fork main"]) expect([text, shell(rules, text)]).toEqual([text, "allow"]);
    });

    it("edits inside its work folder and its result folder, and nowhere else", () => {
      const rules = editorRules();
      expect(decide(rules, "edit", "src/a.ts")).toBe("allow");
      expect(decide(rules, "edit", "a/b/c.ts")).toBe("allow");
      expect(decide(rules, "edit", "/etc/passwd")).toBe("deny");
      expect(decide(rules, "edit", "/home/x/other/a.ts")).toBe("deny");
      expect(decide(rules, "edit", "../other.ts")).toBe("deny");
      expect(decide(rules, "edit", `${resultDir}/handoff.md`)).toBe("allow");
      expect(decide(rules, "edit", "/state/fleet-results/r10/handoff.md")).toBe("deny");
      // a person's external_directory ask does not stop the result file
      expect(decide([...SCHEMA_DEFAULT, { action: "external_directory", resource: "*", effect: "ask" }, ...configOf(pane).permissions!], "external_directory", `${resultDir}/*`)).toBe("allow");
    });
  });

  it("tells a role that edits nothing what its shell allows, and the coordinator what a merge is", () => {
    const note = opencode.readOnlyNote!({ merges: false, fleetCommand: fleet });
    expect(note).toContain("git diff --no-ext-diff --no-textconv");
    expect(note).toContain(fleet);
    expect(note).not.toContain("gh pr merge");
    const merging = opencode.readOnlyNote!({ merges: true, fleetCommand: fleet });
    expect(merging).toContain("gh pr merge <number> --merge");
    expect(merging).toContain("git merge --no-ff <branch>");
    expect(merging).toContain("git revert -m 1 --no-edit <sha>");
    expect(merging).toContain("git push origin <branch>");
    expect(merging).toContain("--match-head-commit <sha>");
  });

  it("refuses an opencode that is not version 2 while starting, not once ready: it has no ready check (fixtures/screens: its help)", () => {
    expect(opencode.readyError).toBeUndefined();
  });

  it("leaves a model its list lacks to the TUI: the list holds what the catalog knows, but not every text the TUI accepts", () => {
    expect(opencode.models!.complete).toBe(false);
  });
});

describe("kinds", () => {
  it("splits a :level suffix off a model for the CLIs that take the level apart", () => {
    expect(splitThinking("m:low", "high")).toEqual({ model: "m", thinking: "low" });
    expect(splitThinking("m", "high")).toEqual({ model: "m", thinking: "high" });
    expect(splitThinking(undefined)).toEqual({ model: undefined, thinking: undefined });
  });

  it("knows only the kinds it has an adapter for", () => {
    for (const kind of ["pi", "claude", "codex", "cursor", "agy", "opencode"]) expect(isAgentKind(kind)).toBe(true);
    expect(isAgentKind("gemini")).toBe(false);
    expect(isAgentKind("toString")).toBe(false);
  });
});
