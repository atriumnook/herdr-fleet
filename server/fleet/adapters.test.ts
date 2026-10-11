import { describe, expect, it } from "bun:test";
import { adapterFor, cursorUsage, isAgentKind, opencodePermission, piTurnError, splitThinking, tomlString, withThinking } from "./adapters.ts";

const base = { name: "impl", systemPromptFile: "/tmp/i.md", systemPrompt: "Be brief.\nSay \"done\".", resultDir: "/state/results/r1" };

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

  it("reads the last Error: line pi printed when it gave up at startup", () => {
    expect(pi.startupError('$ pi --model x\nError: Model "x" not found\n$ ')).toBe('Model "x" not found');
    expect(pi.startupError("$ pi\n")).toBeUndefined();
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

  it("fails a turn on the API error it settled with", () => {
    expect(claude.turnError("❯ do it\n  ⎿  API Error: 404 model: no-such-model\n")).toBe("404 model: no-such-model");
    expect(claude.turnError("● Done.\n")).toBeUndefined();
  });

  it("sees a draft in its input, but not the dim placeholder there (Claude Code 2.1, read with colors)", () => {
    const rule = "\x1b[0m\x1b[38;2;136;136;136m────────\n";
    const screen = (input: string) => `\x1b[0m❯ claude --permission-mode auto\n${rule}❯\u00a0${input}\r\n${rule}  \x1b[0m\x1b[38;2;255;193;7m⏵⏵ auto mode on\x1b[0m\n`;
    expect(claude.draft!(screen("draft text here"))).toBe(true);
    expect(claude.draft!(screen("あいう"))).toBe(true);
    expect(claude.draft!(screen('\x1b[0m\x1b[2mTry "fix lint errors"\x1b[0m'))).toBe(false);
    expect(claude.draft!(screen(""))).toBe(false);
    // a shell prompt's ❯ is followed by a plain space
    expect(claude.draft!("❯ claude\n")).toBe(false);
  });
});

describe("codex adapter", () => {
  const codex = adapterFor("codex");

  it("passes the instructions as developer_instructions on one argv line, and the level as reasoning effort", () => {
    const args = codex.launchArgs({ ...base, model: "gpt-5.5", thinking: "max" });
    expect(args).toEqual([
      "--model", "gpt-5.5", "-c", 'model_reasoning_effort="max"', "-c", expect.stringMatching(/^developer_instructions="Be brief\.\\nSay \\"done\\"\.\\n\\n/), "--approve-for-me", "--add-dir", "/state/results/r1",
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

  it("escapes what a TOML basic string cannot hold raw", () => {
    expect(tomlString("a\tb\\c\u0001\u007f")).toBe('"a\\tb\\\\c\\u0001\\u007F"');
  });

  it("fails a turn on codex's last error line", () => {
    expect(codex.turnError("› do it\n■ unexpected status 401 Unauthorized\n")).toBe("unexpected status 401 Unauthorized");
    expect(codex.turnError("• Done.\n")).toBeUndefined();
  });
});

describe("cursor adapter", () => {
  const cursor = adapterFor("cursor");

  it("is given the folder of all result folders, so it asks to trust one folder once rather than one per run", () => {
    expect(cursor.launchArgs(base).at(-1)).toBe("/state/results");
  });

  it("is ready once its input shows", () => {
    expect(cursor.inputReady?.("  Cursor Agent\n  → Plan, search, build anything\n")).toBe(true);
    expect(cursor.inputReady?.("❯ cursor-agent --model x\n")).toBe(false);
  });

  it("no longer asks once its input is drawn after the answered question", () => {
    const answered = "│  ⚠ Workspace Trust Required  │\n│  ⏳ Trusting workspace...  │\n  Cursor Agent\n  → Plan, search, build anything\n";
    expect(cursor.question?.(answered)).toBeUndefined();
  });

  it("has no instruction option or level: the instructions lead the first prompt", () => {
    expect(cursor.launchArgs({ ...base, model: "gpt-5:high", thinking: "low" })).toEqual(["--model", "gpt-5", "--auto-review", "--add-dir", "/state/results"]);
    expect(cursor.instructionsInPrompt).toBe(true);
  });

  it("calls the workspace trust question herdr reports as idle a block", () => {
    expect(cursor.question?.("│  ⚠ Workspace Trust Required  │\n│  ▶ [a] Trust this workspace │")).toBe("Cursor Agent asks whether to trust this folder.");
    expect(cursor.question?.("→ Plan, search, build anything")).toBeUndefined();
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

  it("takes the model and effort, with instructions in the first prompt", () => {
    expect(agy.launchArgs({ ...base, model: "gemini-3.8-pro", thinking: "xhigh" })).toEqual(["--model", "gemini-3.8-pro", "--effort", "high", "--mode", "accept-edits", "--add-dir", "/state/results/r1"]);
    expect(agy.instructionsInPrompt).toBe(true);
  });

  it("blocks on the trust, sign-in and approval screens herdr reports as idle", () => {
    expect(agy.question?.("Do you trust the contents of this project?\n> Yes, I trust this folder")).toContain("trust");
    expect(agy.question?.("Welcome to the Antigravity CLI. You are currently not signed in.")).toContain("not signed in");
    expect(agy.question?.("Requesting permission for:\n   ls -la /tmp\n\nRun this command?\n> 1. Yes, run command")).toContain("permission");
    expect(agy.question?.("● E2E-OK\n>")).toBeUndefined();
  });

  it("no longer asks once an approved tool ran and its input is back", () => {
    const approved = "Requesting permission for:\n   ls\nRun this command?\n> 1. Yes, run command\n● Bash(ls)\n● E2E-OK\n──────\n>\n──────\n? for shortcuts";
    expect(agy.question?.(approved)).toBeUndefined();
    expect(agy.question?.("──────\n>\n──────\n> do it\n● Bash(ls)\nRequesting permission for:\n   ls\n> 1. Yes, run command")).toContain("permission");
  });

  it("refuses to run the default model in place of an unknown one", () => {
    const screen = '⚠ Warning\n  ⎿  model no-such-model is not recognized as a known model or custom model in settings. Using "Gemini 3.8 Flash\n';
    expect(agy.readyError?.(screen)).toContain("Unknown model no-such-model");
    expect(agy.readyError?.("Antigravity CLI 1.2.16\n>")).toBeUndefined();
  });
});

describe("opencode adapter", () => {
  const opencode = adapterFor("opencode");
  const pane = { resultDir: "/state/fleet-results/r1", fleetCommand: "/usr/bin/bun /opt/fleet/bin/fleet.ts" };

  it("takes the model as provider/model, no thinking level, no approve-everything flag, and instructions in the first prompt", () => {
    expect(opencode.launchArgs({ ...base, model: "anthropic/claude-sonnet-5-5", thinking: "high" })).toEqual(["--model", "anthropic/claude-sonnet-5-5"]);
    expect(opencode.launchArgs({ ...base, model: "p/m:low" })).toEqual(["--model", "p/m"]);
    expect(opencode.launchArgs(base)).toEqual([]);
    expect(opencode.instructionsInPrompt).toBe(true);
    expect(opencode.readOnlyArgs).toEqual(["--agent", "fleet-readonly"]);
  });

  it("turns off its self-update, session sharing and language-server downloads in the pane", () => {
    expect(opencode.env?.(pane)).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_SHARE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true" });
  });

  it("asks before any shell command that is not on its short read-only list, and never allows everything", () => {
    const permission = opencodePermission(pane) as { bash: Record<string, string>; edit: Record<string, string>; external_directory: Record<string, string> };
    expect(Object.entries(permission.bash)[0]).toEqual(["*", "ask"]);
    expect(permission.bash["/usr/bin/bun /opt/fleet/bin/fleet.ts *"]).toBe("allow");
    expect(permission.bash["git status"]).toBe("allow");
    expect(permission.bash["git push *"]).toBeUndefined();
    // a pattern ending in `*` also matches arguments (`git diff --output=f`): only the fleet command has one
    const wild = Object.keys(permission.bash).filter((pattern) => permission.bash[pattern] === "allow" && pattern.endsWith("*"));
    expect(wild).toEqual(["/usr/bin/bun /opt/fleet/bin/fleet.ts *"]);
    // the asks come last, so they win over every allow
    const rules = Object.entries(permission.bash);
    expect(rules.slice(rules.findIndex(([, action], i) => i > 0 && action === "ask")).every(([, action]) => action === "ask")).toBe(true);
    // only this run's result folder is opened to edits and to paths outside the workspace
    expect(permission.edit).toEqual({ "*/fleet-results/r1/*": "allow" });
    expect(permission.external_directory).toEqual({ "/state/fleet-results/r1/*": "allow" });
    const sent = JSON.parse(opencode.env!(pane)["OPENCODE_PERMISSION"]!);
    expect(sent).toEqual(permission);
    expect(Object.values(sent).includes("allow")).toBe(false);
  });

  /**
   * opencode 1.19.0 (the bundled JS of the binary, read with `strings`), the parts this follows:
   * - shell tool, `collect`: every `command` node under the parsed input is looked at on its own
   *   (`vi(c)` = `descendantsOfType("command")`, so `;`, `&&`, `|` and `$(...)` yield several),
   *   and each one that is not exempt adds `Pi(U)` to the patterns it asks about;
   * - `Pi(o)`: `o.parent?.type === "redirected_statement" ? o.parent.text : o.text` - a command with
   *   a redirect is asked about as the text of the whole statement, redirect included;
   * - `Wildcard.match` (`JH`): `*` becomes `.*`, `?` becomes `.`, a trailing ` *` is optional,
   *   anchored, flag `s`;
   * - `Permission.evaluate` (`c`): `findLast` over the merged rules, `ask` when none matches.
   * The tool asks when any of its patterns evaluates to ask.
   */
  describe("under opencode's matching", () => {
    const rules = Object.entries((opencodePermission(pane) as { bash: Record<string, string> }).bash);
    const match = (text: string, pattern: string) => {
      let source = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
      return new RegExp(`^${source}$`, "s").test(text.replaceAll("\\", "/"));
    };
    const action = (text: string) => [...rules].reverse().find(([pattern]) => match(text, pattern))?.[1] ?? "ask";
    /** what the tool decides for a command line, given the statements it parses out of it */
    const verdict = (...patterns: string[]) => (patterns.every((pattern) => action(pattern) === "allow") ? "allow" : "ask");
    const fleet = "/usr/bin/bun /opt/fleet/bin/fleet.ts";

    it("lets the listed commands and the fleet command through", () => {
      for (const text of ["ls", "pwd", "git status", "git ls-files", `${fleet} list`, `${fleet} send lead "go"`]) expect(verdict(text)).toBe("allow");
    });

    it("asks when a redirect, a second command or a substitution comes with one", () => {
      expect(verdict("ls > ~/y")).toBe("ask");
      expect(verdict("git show HEAD:f > ~/.bashrc")).toBe("ask");
      expect(verdict(`${fleet} send lead "x" > ~/x`)).toBe("ask");
      expect(verdict("cat < /etc/passwd")).toBe("ask");
      expect(verdict("ls", "rm -rf ~")).toBe("ask"); // ls; rm -rf ~
      expect(verdict("ls", "git push")).toBe("ask"); // ls && git push
      expect(verdict("ls $(rm x)", "rm x")).toBe("ask"); // ls $(rm x)
    });

    it("asks for the arguments that write or run helpers, and for anything not listed", () => {
      for (const text of ["git diff --output=/tmp/x", "git diff --no-index a b", "git log --ext-diff", "git show --textconv x", "git diff", "git log", "git show", "git diff HEAD~1", "git log -1", "rm -rf build", `${fleet} send lead x --output=y`]) expect(verdict(text)).toBe("ask");
    });
  });

  it("defines the read-only agent with a deny that its allowance for the result file follows", () => {
    const config = JSON.parse(opencode.env!(pane)["OPENCODE_CONFIG_CONTENT"]!);
    const edit = config.agent["fleet-readonly"].permission.edit;
    expect(Object.entries(edit)).toEqual([["*", "deny"], ["*/fleet-results/r1/*", "allow"]]);
    expect(config.agent["fleet-readonly"].mode).toBe("primary");
  });

  it("blocks on a permission request and not once it is answered", () => {
    const asked = "  △ Permission required\n    # Shell command\n    $ rm -rf build\n\n  Allow once   Allow always   Reject";
    expect(opencode.question?.(asked)).toContain("permission");
    expect(opencode.question?.("\x1b[1m△ Permission required\x1b[0m\n Allow\x1b[2m once\x1b[0m")).toContain("permission");
    expect(opencode.question?.("Ask anything… \"Fix broken tests\"\n  Build · Big Pickle")).toBeUndefined();
    expect(opencode.question?.("The docs call it a Permission required screen.")).toBeUndefined();
  });

  it("reads a failed request from its retry line", () => {
    expect(opencode.turnError("working\nRate limit exceeded [retrying in 12s attempt #3]\n")).toBe("Rate limit exceeded");
    expect(opencode.turnError("Provider overloaded [retrying attempt #2]")).toBe("Provider overloaded");
    expect(opencode.turnError("HANDOFF\nPASS")).toBeUndefined();
  });

  it("reads the error line of a CLI that quit while starting", () => {
    expect(opencode.startupError("Error: Unexpected error")).toBe("Unexpected error");
    expect(opencode.startupError("Ask anything…")).toBeUndefined();
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
