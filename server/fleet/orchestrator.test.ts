import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { DEFAULT_CONFIG, mergeConfig } from "./config.ts";
import { AgentWaitTimeoutError, applyModelPolicy, Orchestrator, readResult, RESULT_MAX_BYTES, threadState } from "./orchestrator.ts";
import { RunRegistry } from "./registry.ts";
import { abortableDelay, abortError, FleetError, type AgentMetadata, type AgentRuntime, type CreateLocationOptions, type RuntimeLocation, type StartOptions } from "./runtime.ts";
import type { AgentDefinition, AgentRun, AgentState, FleetConfig } from "./types.ts";
import { UsageTracker } from "./usage.ts";

const GRACE = 60;

class FakeRuntime implements AgentRuntime {
  closed: string[] = [];
  prompts: Array<{ name: string; text: string }> = [];
  starts: StartOptions[] = [];
  locations: CreateLocationOptions[] = [];
  promptStatus: AgentState = "working";
  getStatus: AgentState = "working";
  output = "agent output";
  instructions: string[] = [];
  createLocationImpl?: (options: CreateLocationOptions, signal?: AbortSignal) => Promise<RuntimeLocation>;
  startImpl?: (options: StartOptions) => Promise<AgentState>;
  promptImpl?: (name: string, text: string, signal?: AbortSignal) => Promise<AgentState>;
  getImpl?: (name: string) => Promise<AgentState>;
  private panes = 0;

  async createLocation(options: CreateLocationOptions, signal?: AbortSignal): Promise<RuntimeLocation> {
    this.locations.push(options);
    if (this.createLocationImpl) return this.createLocationImpl(options, signal);
    if (signal?.aborted) throw abortError(signal);
    this.panes += 1;
    return { paneId: `w1:p${this.panes}`, cwd: options.cwd };
  }
  async start(options: StartOptions): Promise<AgentState> {
    this.starts.push(options);
    const flag = options.args.findIndex((arg) => arg.startsWith("--append-system-prompt"));
    const file = flag >= 0 ? options.args[flag + 1] : undefined;
    if (file && existsSync(file)) this.instructions.push(readFileSync(file, "utf8"));
    if (this.startImpl) return this.startImpl(options);
    if (options.signal?.aborted) throw abortError(options.signal);
    return "idle";
  }
  async closePane(paneId: string): Promise<void> { this.closed.push(paneId); }
  async prompt(name: string, text: string, signal?: AbortSignal): Promise<AgentState> {
    if (this.promptImpl) return this.promptImpl(name, text, signal);
    if (signal?.aborted) throw abortError(signal);
    this.prompts.push({ name, text });
    return this.promptStatus;
  }
  async get(name: string): Promise<AgentState> { return this.getImpl ? this.getImpl(name) : this.getStatus; }
  async read(): Promise<string> { return this.output; }
  screens = new Map<string, string>();
  async screen(name: string): Promise<string> { return this.screens.get(name) ?? ""; }
  interrupts = 0;
  interruptImpl?: () => void;
  async interrupt(): Promise<void> { this.interrupts += 1; this.interruptImpl?.(); }
  async focus(): Promise<void> {}
  async reportMetadata(_metadata: AgentMetadata): Promise<void> {}
}

const role = (name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name, description: name, agent: "pi", systemPrompt: `You are ${name}.`, source: "bundled", filePath: `${name}.md`, ...extra,
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface SetupOptions {
  config?: Partial<FleetConfig> | Record<string, unknown>; agents?: AgentDefinition[]; usage?: UsageTracker;
  gitRoot?: (cwd: string) => Promise<string | null>; runSetup?: (cwd: string, command: string) => Promise<{ ok: boolean; output: string }>;
  excludeWorktrees?: (repo: string) => Promise<void>;
  standingOrders?: (cwd: string) => string;
  draftRetryMs?: number;
}

function setup(options: SetupOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "fleet-orchestrator-"));
  roots.push(root);
  const runtime = new FakeRuntime();
  const registry = new RunRegistry(join(root, "runs.json"));
  const config = mergeConfig(DEFAULT_CONFIG, options.config as Record<string, unknown> ?? {});
  const fleet = new Orchestrator({
    runtime, registry, config: () => config, agents: () => options.agents ?? [role("worker"), role("reviewer", { interactive: true })],
    fleetCommand: "fleet", agentEnv: () => ({ HERDR_FLEET_URL: "http://127.0.0.1:1" }), promptDir: root, resultsDir: join(root, "results"), instructionsDir: join(root, "instructions"), preVisualGraceMs: GRACE, readyScreenMs: 300,
    usage: options.usage, usageScreenMs: 300, gitRoot: options.gitRoot ?? (async () => null), runSetup: options.runSetup, excludeWorktrees: options.excludeWorktrees ?? (async () => {}), standingOrders: options.standingOrders,
    draftRetryMs: options.draftRetryMs,
  });
  return { fleet, runtime, registry, root };
}

const spawn = (fleet: Orchestrator, extra: Record<string, unknown> = {}) => fleet.spawn({ role: "worker", task: "do it", group: "g1", cwd: "/work", ...extra });
const until = async (check: () => boolean, label: string, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await Bun.sleep(5); }
};

describe("spawn", () => {
  it("starts the role's agent beside the caller with its instructions in a file, then hands it the task", async () => {
    const { fleet, runtime, root } = setup();
    const run = await spawn(fleet, { callerPaneId: "w0:p1", name: "impl" });
    expect(run).toMatchObject({ name: "impl", role: "worker", agent: "pi", group: "g1", depth: 1, state: "working" });
    expect(runtime.locations[0]).toMatchObject({ cwd: "/work", callerPaneId: "w0:p1", env: { HERDR_FLEET_URL: "http://127.0.0.1:1", HERDR_FLEET_GROUP: "g1", HERDR_FLEET_DEPTH: "1", HERDR_FLEET_RUN: run.id } });
    expect(runtime.starts[0]!.args).toContain("--append-system-prompt");
    expect(runtime.instructions[0]).toContain("You are worker.");
    expect(runtime.instructions[0]).toContain("fleet send <name-or-id>");
    expect(runtime.instructions[0]).toContain("Do not start other agents.");
    // a caller reads the status line first, without the whole report
    expect(runtime.instructions[0]).toContain("The HANDOFF opens with one status line, PASS, ISSUES or BLOCKED");
    expect(runtime.prompts).toEqual([{ name: run.herdrName, text: "do it" }]);
    // the instruction file is gone once the agent has read it at startup
    expect(require("node:fs").readdirSync(root).filter((name: string) => name.startsWith("herdr-fleet-"))).toEqual([]);
  });

  it("asks an agent caller for a full brief before any pane, and hands its helper the brief as the task", async () => {
    const { fleet, runtime } = setup();
    await expect(spawn(fleet, { depth: 1 })).rejects.toMatchObject({ code: "incomplete_brief" });
    expect(runtime.locations).toEqual([]);
    const brief = { goal: "Fix the retry.", write: ["src/retry.ts"], context: "none", done: "One notification per retry.", verify: "bun test" };
    const run = await spawn(fleet, { depth: 1, task: undefined, brief });
    expect(run.write).toEqual(["/work/src/retry.ts"]);
    expect(runtime.prompts[0]!.text).toContain("## Goal\n\nFix the retry.");
  });

  it("refuses a second writer of paths a working agent holds, and lets it in once that agent's turn settles", async () => {
    const { fleet, runtime, registry } = setup();
    const brief = { goal: "g", write: ["src"], context: "none", done: "d", verify: "v" };
    const first = await spawn(fleet, { depth: 1, brief });
    const error = await spawn(fleet, { depth: 1, brief: { ...brief, write: ["src/retry.ts"] } }).catch((e) => e);
    expect(error).toMatchObject({ code: "scope_conflict" });
    expect(error.message).toContain(`worker (${first.id}) is still changing /work/src`);
    expect(runtime.locations).toHaveLength(1);
    // a reader holds nothing, and a worktree run writes its own checkout
    await spawn(fleet, { depth: 1, brief: { ...brief, write: [] } });
    expect((await spawn(fleet, { depth: 1, brief, worktree: true })).write).toBeUndefined();
    registry.upsert({ ...registry.get(first.id)!, state: "idle" });
    await spawn(fleet, { depth: 1, brief: { ...brief, write: ["src/retry.ts"] } });
  });

  it("gives every agent the standing orders of the folder it starts in, and no section without any", async () => {
    const asked: string[] = [];
    const { fleet, runtime } = setup({ standingOrders: (cwd) => { asked.push(cwd); return "1. Ask before a push."; } });
    await spawn(fleet);
    expect(asked).toEqual(["/work"]);
    expect(runtime.instructions[0]).toContain("## Standing orders");
    expect(runtime.instructions[0]).toContain("1. Ask before a push.");
    const bare = setup({ standingOrders: () => "" });
    await spawn(bare.fleet);
    expect(bare.runtime.instructions[0]).not.toContain("Standing orders");
  });

  it("names the fleet command in every spawning instruction", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { spawning: true })] });
    await spawn(fleet);
    expect(runtime.instructions[0]).toContain("(fleet list shows each agent's CLI)");
    expect(runtime.instructions[0]).not.toContain("${");
  });

  it("records the idle herdr shows right after a prompt as working", async () => {
    const { fleet, runtime } = setup();
    runtime.promptStatus = "idle";
    expect((await spawn(fleet)).state).toBe("working");
  });

  it("refuses an unknown role, an invalid thinking level and a caller too deep, before any pane", async () => {
    const { fleet, runtime } = setup();
    await expect(spawn(fleet, { role: "nobody" })).rejects.toThrow("Unknown agent role");
    await expect(spawn(fleet, { thinking: "turbo" })).rejects.toThrow("Invalid thinking level");
    await expect(spawn(fleet, { depth: 3 })).rejects.toMatchObject({ code: "depth_limit" });
    await expect(spawn(fleet, { group: "bad group" })).rejects.toMatchObject({ code: "invalid_group" });
    expect(runtime.locations).toEqual([]);
  });

  it("closes the pane when the agent does not start, and records the failure", async () => {
    const { fleet, runtime, registry } = setup();
    runtime.startImpl = async () => { throw new HerdrError("agent_start_failed_herdr", "boom"); };
    await expect(spawn(fleet)).rejects.toThrow("boom");
    expect(runtime.closed).toEqual(["w1:p1"]);
    expect(registry.all()[0]).toMatchObject({ state: "failed", lastError: "boom" });
  });

  it("leaves the task unsent when the agent stops at a question while starting", async () => {
    const { fleet, runtime } = setup();
    runtime.startImpl = async () => "blocked";
    const run = await spawn(fleet);
    expect(run.state).toBe("blocked");
    expect(run.lastError).toContain("not been sent");
    expect(runtime.prompts).toEqual([]);
  });

  it("leaves the task unsent when the agent never became ready, whatever state herdr reads afterwards", async () => {
    const { fleet, runtime } = setup();
    runtime.startImpl = async () => { throw new FleetError("agent_not_ready", "not ready within 30s"); };
    runtime.getStatus = "idle";
    const run = await spawn(fleet);
    expect(run).toMatchObject({ state: "idle" });
    expect(run.lastError).toContain("not been sent");
    expect(runtime.prompts).toEqual([]);
  });

  it("checks the concurrency budget one spawn at a time, so parallel spawns cannot overshoot it", async () => {
    const { fleet, runtime } = setup({ config: { maxConcurrent: 2 } });
    runtime.createLocationImpl = async (options) => { await Bun.sleep(10); return { paneId: `w1:p${runtime.locations.length}`, cwd: options.cwd }; };
    const results = await Promise.allSettled([spawn(fleet), spawn(fleet), spawn(fleet)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "concurrency_limit" } });
  });

  it("cancels a spawn during pane creation without leaving a run, and during start by closing the pane", async () => {
    const { fleet, runtime, registry } = setup();
    const first = new AbortController();
    runtime.createLocationImpl = async (options, signal) => { await abortableDelay(200, signal); return { paneId: "w1:p9", cwd: options.cwd }; };
    const pending = fleet.spawn({ role: "worker", task: "t", group: "g1", cwd: "/w" }, first.signal);
    setTimeout(() => first.abort(), 10);
    await expect(pending).rejects.toThrow();
    expect(registry.all()).toEqual([]);

    runtime.createLocationImpl = undefined;
    const second = new AbortController();
    runtime.startImpl = async (options) => { await abortableDelay(200, options.signal); return "idle"; };
    const starting = fleet.spawn({ role: "worker", task: "t", group: "g1", cwd: "/w" }, second.signal);
    setTimeout(() => second.abort(), 10);
    await expect(starting).rejects.toThrow();
    expect(runtime.closed).toEqual(["w1:p1"]);
    expect(registry.all()[0]).toMatchObject({ state: "stopped", lastError: "Spawn cancelled." });
  });
});

describe("turns", () => {
  it("settles a turn when herdr reports it finished, hands the output to the waiter, and closes a non-interactive pane", async () => {
    const { fleet, runtime } = setup();
    const run = await spawn(fleet);
    const waiting = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "done";
    runtime.output = "work\nHANDOFF: done";
    fleet.onPaneStatus(run.paneId);
    const settled = await waiting;
    expect(settled).toMatchObject({ state: "done", lastOutput: "work\nHANDOFF: done" });
    await until(() => fleet.get(run.id).state === "stopped", "pane closed");
    expect(runtime.closed).toEqual([run.paneId]);
  });

  it("keeps an interactive agent's pane, and every pane when closeOnSettle is off", async () => {
    for (const [config, roleName] of [[{}, "reviewer"], [{ closeOnSettle: false }, "worker"]] as const) {
      const { fleet, runtime } = setup({ config });
      const run = await spawn(fleet, { role: roleName });
      const waiting = fleet.wait(run.id, 2000, "g1");
      runtime.getStatus = "idle";
      await Bun.sleep(GRACE + 10);
      fleet.onPaneStatus(run.paneId);
      expect((await waiting).state).toBe("idle");
      await Bun.sleep(20);
      expect(runtime.closed).toEqual([]);
    }
  });

  it("does not take the idle from before the prompt for a finished turn; the check after the grace period does", async () => {
    const { fleet, runtime } = setup();
    runtime.promptStatus = "idle";
    runtime.getStatus = "idle";
    const run = await spawn(fleet);
    fleet.onPaneStatus(run.paneId);
    await Bun.sleep(10);
    expect(fleet.get(run.id).state).toBe("working");
    expect(runtime.closed).toEqual([]);
    const settled = await fleet.wait(run.id, 2000, "g1");
    expect(settled.state).toBe("idle");
  });

  it("does not let the settle check of an earlier turn finish a follow-up", async () => {
    const { fleet, runtime } = setup();
    runtime.promptStatus = "idle";
    runtime.getStatus = "working";
    const run = await spawn(fleet);
    await Bun.sleep(GRACE / 2);
    await fleet.send(run.id, "next", "g1");
    runtime.getStatus = "idle";
    // the first turn's timer would fire now; the follow-up's grace has not passed yet
    await Bun.sleep(GRACE / 2 + 5);
    fleet.onPaneStatus(run.paneId);
    await Bun.sleep(5);
    expect(fleet.get(run.id).state).toBe("working");
  });

  it("reports a block to the waiter with the screen, and keeps the turn and the pane", async () => {
    const { fleet, runtime } = setup();
    const run = await spawn(fleet);
    const waiting = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "blocked";
    runtime.output = "Allow edit? [y/n]";
    fleet.onPaneStatus(run.paneId);
    expect(await waiting).toMatchObject({ state: "blocked", lastOutput: "Allow edit? [y/n]" });
    // a second wait on the same block answers at once
    expect((await fleet.wait(run.id, 50, "g1")).state).toBe("blocked");
    expect(runtime.closed).toEqual([]);
    runtime.getStatus = "working";
    fleet.onPaneStatus(run.paneId);
    await Bun.sleep(5);
    const next = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "done";
    runtime.output = "HANDOFF";
    fleet.onPaneStatus(run.paneId);
    expect((await next).state).toBe("done");
  });

  it("surfaces herdr refusing a prompt to a blocked agent, without a turn in flight", async () => {
    const { fleet, runtime } = setup();
    const run = await spawn(fleet);
    runtime.promptImpl = async () => { throw new HerdrError("agent_blocked", "agent is blocked"); };
    runtime.output = "Trust this folder?";
    const sent = await fleet.send(run.id, "more", "g1");
    expect(sent).toMatchObject({ state: "blocked", lastOutput: "Trust this folder?" });
  });

  it("times a wait out with the state read back, and cancels one with the request", async () => {
    const { fleet } = setup();
    const run = await spawn(fleet);
    const timedOut = await fleet.wait(run.id, 30, "g1").catch((error) => error);
    expect(timedOut).toBeInstanceOf(AgentWaitTimeoutError);
    expect(timedOut.run.state).toBe("working");
    const control = new AbortController();
    const cancelled = fleet.wait(run.id, 2000, "g1", control.signal);
    control.abort();
    await expect(cancelled).rejects.toThrow();
  });

  it("ends a run whose pane went away, waking its waiter; a failed run keeps its verdict", async () => {
    const { fleet } = setup();
    const run = await spawn(fleet);
    const waiting = fleet.wait(run.id, 2000, "g1");
    fleet.onPaneEnded(run.paneId);
    expect((await waiting).state).toBe("stopped");
    await expect(fleet.send(run.id, "x", "g1")).rejects.toMatchObject({ code: "run_ended" });
  });

  it("stops a run herdr no longer knows, but not one still inside its start", async () => {
    const { fleet, runtime, registry } = setup();
    const run = await spawn(fleet);
    runtime.getImpl = async () => { throw new HerdrError("agent_not_found", "gone"); };
    registry.upsert({ ...fleet.get(run.id), id: "young", herdrName: "young", paneId: "w1:p99", state: "starting", startedAt: Date.now() });
    await fleet.reconcileAll();
    expect(fleet.get(run.id).state).toBe("stopped");
    expect(fleet.get("young").state).toBe("starting");
  });

  it("closes only finished non-interactive panes herdr still reports done", async () => {
    const { fleet, runtime, registry } = setup();
    const base = { group: "g1", agent: "pi" as const, cwd: "/w", depth: 1, worktree: false, startedAt: 1, updatedAt: 1 };
    for (const [id, state, interactive] of [["d1", "done", false], ["i1", "idle", false], ["b1", "blocked", false], ["di", "done", true]] as const) {
      registry.upsert({ ...base, id, name: id, role: "worker", herdrName: id, paneId: `w1:${id}`, state, interactive });
    }
    runtime.getImpl = async (name) => (name === "d1" || name === "di" ? "done" : name === "i1" ? "idle" : "blocked");
    const closed = await fleet.closeDone("g1");
    expect(closed.map((run) => run.id)).toEqual(["d1"]);
    expect(runtime.closed).toEqual(["w1:d1"]);
  });

  it("addresses runs within the caller's fleet only", async () => {
    const { fleet } = setup();
    const run = await spawn(fleet, { name: "impl" });
    expect(fleet.get("impl", "g1").id).toBe(run.id);
    expect(() => fleet.get("impl", "other")).toThrow("Unknown fleet agent");
    expect(fleet.list("other")).toEqual([]);
  });
});

describe("model thinking policy", () => {
  const config = mergeConfig(DEFAULT_CONFIG, { models: { "p/strong": { thinking: ["low", "medium"] } } });
  it("refuses an explicit level or a :level suffix outside the model's list", () => {
    expect(() => applyModelPolicy(config, "p/strong", "high", true)).toThrow('Thinking level "high" is not allowed for p/strong. Allowed: low, medium.');
    expect(() => applyModelPolicy(config, "p/strong:max", undefined, false)).toThrow(FleetError);
  });
  it("lowers an inherited level to the highest allowed one, and leaves models without a list alone", () => {
    expect(applyModelPolicy(config, "p/strong", "max", false)).toBe("medium");
    expect(applyModelPolicy(config, "p/strong", "low", true)).toBe("low");
    expect(applyModelPolicy(config, "p/other", "max", true)).toBe("max");
  });
  it("applies to role-level levels on spawn, before any pane", async () => {
    const { fleet, runtime } = setup({ config: { models: { "p/strong": { thinking: ["low"] } } }, agents: [role("worker", { model: "p/strong", thinking: "high" })] });
    await expect(spawn(fleet)).rejects.toMatchObject({ code: "thinking_not_allowed" });
    expect(runtime.locations).toEqual([]);
  });
});

describe("model fallbacks", () => {
  const fallbackRole = () => [role("worker", { model: "p/primary", fallbackModels: ["p/second", "p/third"] })];

  it("moves to the next configured model when the agent quits at startup", async () => {
    const { fleet, runtime } = setup({ agents: fallbackRole() });
    runtime.startImpl = async (options) => {
      if (options.args.includes("p/primary")) throw new FleetError("agent_start_failed", 'Model "p/primary" not found');
      return "idle";
    };
    const run = await spawn(fleet);
    expect(run).toMatchObject({ model: "p/second", fallbackFrom: "p/primary", state: "working" });
    expect(runtime.closed).toEqual(["w1:p1"]);
  });

  it("does not fall back on errors that are not the model's, and reports every failure once all are spent", async () => {
    const other = setup({ agents: fallbackRole() });
    other.runtime.startImpl = async () => { throw new HerdrError("pane_not_found", "pane vanished"); };
    await expect(spawn(other.fleet)).rejects.toThrow("pane vanished");
    expect(other.runtime.starts).toHaveLength(1);

    const spent = setup({ agents: fallbackRole() });
    spent.runtime.startImpl = async (options) => { throw new FleetError("agent_start_failed", `${options.args[1]} down`); };
    await expect(spawn(spent.fleet)).rejects.toThrow("p/third down. Fallbacks exhausted: p/primary: p/primary down; p/second: p/second down");
  });

  it("bounds a fallback model by its own allow-list instead of refusing it", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { model: "p/primary", thinking: "high", fallbackModels: ["p/small"] })], config: { models: { "p/small": { thinking: ["low"] } } } });
    runtime.startImpl = async (options) => {
      if (options.args.some((arg) => arg.startsWith("p/primary"))) throw new FleetError("agent_start_failed", "no");
      return "idle";
    };
    const run = await spawn(fleet);
    expect(run).toMatchObject({ model: "p/small", thinking: "low" });
  });

  it("re-spawns the task on the next model when the first turn ends in an API error, and names the replacement", async () => {
    const { fleet, runtime } = setup({ agents: fallbackRole() });
    const run = await spawn(fleet);
    const waiting = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "idle";
    runtime.output = "Error: 429 rate limited";
    await Bun.sleep(GRACE + 5);
    runtime.output = "Error: 429 rate limited";
    fleet.onPaneStatus(run.paneId);
    const failed = await waiting;
    expect(failed).toMatchObject({ state: "failed", lastError: "429 rate limited" });
    const replacement = fleet.get(failed.replacedBy!, "g1");
    expect(replacement).toMatchObject({ model: "p/second", fallbackFrom: "p/primary" });
    expect(runtime.prompts.map((p) => p.text)).toEqual(["do it", "do it"]);
  });

  it("does not count an Error: line inside a real handoff, and never re-spawns after a later turn", async () => {
    // closeOnSettle off: a non-interactive pane closes once its turn settles, and a second turn needs it
    const { fleet, runtime } = setup({ agents: fallbackRole(), config: { closeOnSettle: false } });
    const run = await spawn(fleet);
    runtime.getStatus = "idle";
    runtime.output = "Error: flaky test, fixed\nHANDOFF: done";
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(run.paneId);
    expect((await fleet.wait(run.id, 2000, "g1")).state).toBe("idle");

    runtime.getStatus = "working";
    await fleet.send(run.id, "again", "g1");
    const waiting = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "idle";
    runtime.output = "Error: quota";
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(run.paneId);
    expect(await waiting).toMatchObject({ state: "failed", lastError: "quota" });
    expect(fleet.get(run.id).replacedBy).toBeUndefined();
    expect(runtime.starts).toHaveLength(1);
  });
});

describe("usage routing", () => {
  const NOW = Date.now();
  const full = { readAt: NOW, windows: [{ name: "5h", usedPercent: 95, resetsAt: NOW + 3_600_000 }] };
  const crossRole = () => [role("worker", { model: "p/primary", fallbackModels: ["codex:gpt-6", "claude:sonnet"] })];

  it("skips a candidate whose account is used past the threshold, onto another CLI", async () => {
    const usage = new UsageTracker({ file: null });
    usage.record("pi:p", full);
    const { fleet, runtime } = setup({ agents: crossRole(), usage });
    const run = await spawn(fleet);
    expect(run).toMatchObject({ agent: "codex", model: "gpt-6", fallbackFrom: "p/primary", state: "working" });
    // the run keeps why it is not on the primary, for the Fleet screen
    expect(run.skipped).toEqual([{ candidate: "p/primary", reason: expect.stringContaining("pi:p has used 95% of its 5h limit") }]);
    expect(runtime.starts.map((s) => s.kind)).toEqual(["codex"]);
    expect(runtime.locations).toHaveLength(1);
  });

  it("refuses the spawn, before any pane, when no candidate has usage left", async () => {
    const usage = new UsageTracker({ file: null });
    for (const key of ["pi:p", "codex"]) usage.record(key, full);
    usage.noteFailure("claude", "sonnet", "rate limit reached", 60);
    const { fleet, runtime } = setup({ agents: crossRole(), usage, config: { maxUsedPercent: 95 } });
    const error = await spawn(fleet).catch((e) => e);
    expect(error).toMatchObject({ code: "usage_exhausted" });
    expect(error.message).toContain("p/primary: pi:p has used 95% of its 5h limit");
    expect(error.message).toContain("claude:sonnet: claude is cooling down");
    expect(runtime.locations).toEqual([]);
  });

  it("keeps the CLIs a caller avoids out, onto the next candidate, and says why", async () => {
    const { fleet, runtime } = setup({ agents: crossRole() });
    const run = await spawn(fleet, { avoid: ["pi"] });
    expect(run).toMatchObject({ agent: "codex", model: "gpt-6", fallbackFrom: "p/primary" });
    expect(run.skipped).toEqual([{ candidate: "p/primary", reason: "the caller keeps pi out" }]);
    expect(runtime.starts.map((s) => s.kind)).toEqual(["codex"]);
  });

  it("refuses the spawn, before any pane, when the caller avoids every candidate's CLI", async () => {
    const { fleet, runtime } = setup({ agents: crossRole() });
    const error = await spawn(fleet, { avoid: ["pi", "codex", "claude"] }).catch((e) => e);
    expect(error).toMatchObject({ code: "no_candidates" });
    expect(error.message).toContain("claude:sonnet: the caller keeps claude out");
    expect(runtime.locations).toEqual([]);
  });

  it("plays a role that edits nothing only on a CLI that can be held to that, with its editing tools off", async () => {
    const { fleet, runtime } = setup({ agents: [role("auditor", { model: "codex:gpt-6", fallbackModels: ["claude:sonnet"], edits: false })] });
    const run = await spawn(fleet, { role: "auditor" });
    expect(run).toMatchObject({ agent: "claude", model: "sonnet" });
    expect(run.skipped).toEqual([{ candidate: "codex:gpt-6", reason: "codex cannot be kept from editing files" }]);
    expect(runtime.starts[0]!.args.join(" ")).toContain("--disallowedTools Edit,Write,NotebookEdit");
    expect(runtime.instructions[0]).toContain("your file-editing tools are off: write your result file with a shell command");
  });

  it("refuses a role that edits nothing when no candidate CLI can be held to that", async () => {
    const { fleet, runtime } = setup({ agents: [role("auditor", { model: "codex:gpt-6", fallbackModels: ["cursor:auto"], edits: false })] });
    const error = await spawn(fleet, { role: "auditor" }).catch((e) => e);
    expect(error).toMatchObject({ code: "no_candidates" });
    expect(error.message).toContain("cursor:auto: cursor cannot be kept from editing files");
    expect(runtime.locations).toEqual([]);
  });

  it("leaves a role's editing tools as they are unless it says it edits nothing", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { model: "claude:sonnet" })] });
    await spawn(fleet);
    expect(runtime.starts[0]!.args).not.toContain("--disallowedTools");
  });

  it("lets a caller pick another CLI with an <agent>:<model> model", async () => {
    const { fleet, runtime } = setup();
    const run = await spawn(fleet, { model: "agy:gemini-pro" });
    expect(run).toMatchObject({ agent: "agy", model: "gemini-pro" });
    expect(runtime.starts[0]!.kind).toBe("agy");
  });

  it("cools down the account a start quit on with a rate limit, and moves on", async () => {
    const usage = new UsageTracker({ file: null });
    const { fleet, runtime } = setup({ agents: crossRole(), usage });
    runtime.startImpl = async (options) => {
      if (options.kind === "pi") throw new FleetError("agent_start_failed", "429 Too Many Requests");
      return "idle";
    };
    const run = await spawn(fleet);
    expect(run).toMatchObject({ agent: "codex", skipped: [{ candidate: "p/primary", reason: "429 Too Many Requests" }] });
    expect(await usage.unavailable("pi", "p/primary", 90)).toContain("pi:p is cooling down");
  });

  it("cools down the account a first turn hit a rate limit on, and re-spawns past it", async () => {
    const usage = new UsageTracker({ file: null });
    const { fleet, runtime } = setup({ agents: [role("worker", { agent: "claude", model: "sonnet", fallbackModels: ["opus", "codex:gpt-6"] })], usage });
    const run = await spawn(fleet);
    const waiting = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "idle";
    runtime.output = "⎿  API Error: Claude usage limit reached. Your limit will reset in 2 hours";
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(run.paneId);
    const failed = await waiting;
    expect(failed).toMatchObject({ state: "failed" });
    // opus draws on the same claude account: the replacement skips it
    expect(fleet.get(failed.replacedBy!, "g1")).toMatchObject({ agent: "codex", model: "gpt-6", fallbackFrom: "opus" });
    expect(usage.list().find((e) => e.key === "claude")!.cooldown!.until).toBeGreaterThan(Date.now() + 7_000_000);
  });

  describe("cursor's /usage screen", () => {
    const INPUT = "→ Plan, search, build anything";
    const PAGER = "Usage · Pro    Resets Oct 23\nIncluded        12% used        ███░░░";

    async function settleCursorTurn(usage: UsageTracker, pagerAfterPrompt = true, interactive = false) {
      const { fleet, runtime } = setup({ agents: [role("worker", { agent: "cursor", interactive })], usage });
      runtime.output = INPUT;
      const run = await spawn(fleet);
      runtime.promptImpl = async (name, text) => {
        runtime.prompts.push({ name, text });
        if (text === "/usage") {
          // herdr calls it working while the pager loads, and idle a moment after Esc
          runtime.getStatus = "working";
          fleet.onPaneStatus(run.paneId);
          if (pagerAfterPrompt) runtime.output = `${INPUT}\n${PAGER}`;
        }
        return "working";
      };
      runtime.interruptImpl = () => { setTimeout(() => { runtime.getStatus = "idle"; }, 100); };
      const waiting = fleet.wait(run.id, 2000, "g1");
      runtime.getStatus = "idle";
      runtime.output = `${INPUT}\n● done`;
      await Bun.sleep(GRACE + 5);
      fleet.onPaneStatus(run.paneId);
      return { settled: await waiting, runtime, fleet, run };
    }

    it("is read once a turn settles, then closed, and the run stays settled", async () => {
      const usage = new UsageTracker({ file: null });
      const { settled, runtime, fleet, run } = await settleCursorTurn(usage);
      expect(settled.state).toBe("idle");
      // the non-interactive pane closes on settle: herdr's working during the pager did not hold it open
      await until(() => runtime.closed.includes(run.paneId), "pane closed");
      expect(fleet.get(run.id).state).toBe("stopped");
      expect(runtime.prompts.map((p) => p.text).at(-1)).toBe("/usage");
      expect(runtime.interrupts).toBe(1);
      expect(usage.list().find((e) => e.key === "cursor")!.reading!.windows[0]).toMatchObject({ name: "monthly", usedPercent: 12 });
    });

    it("holds a send made while it reads until the pager is closed", async () => {
      const usage = new UsageTracker({ file: null });
      const { fleet, runtime } = setup({ agents: [role("worker", { agent: "cursor" })], usage, config: { closeOnSettle: false } });
      runtime.output = INPUT;
      const run = await spawn(fleet);
      let sent: Promise<unknown> | undefined;
      runtime.promptImpl = async (name, text) => {
        runtime.prompts.push({ name, text });
        if (text === "/usage") {
          runtime.output = `${INPUT}\n${PAGER}`;
          sent = fleet.send(run.id, "next task", "g1");
        }
        return "working";
      };
      runtime.interruptImpl = () => { runtime.prompts.push({ name: run.herdrName, text: "<esc>" }); };
      runtime.getStatus = "idle";
      runtime.output = `${INPUT}\n● done`;
      await Bun.sleep(GRACE + 5);
      fleet.onPaneStatus(run.paneId);
      await until(() => sent !== undefined, "send made during the read");
      await sent;
      // Esc closed the pager before the next task was typed, not after
      expect(runtime.prompts.map((p) => p.text).slice(-3)).toEqual(["/usage", "<esc>", "next task"]);
    });

    it("is not asked in an interactive run or while the last reading is fresh, and a screen that never shows it costs only the wait", async () => {
      const fresh = new UsageTracker({ file: null });
      fresh.record("cursor", { readAt: Date.now(), windows: [] });
      const first = await settleCursorTurn(fresh);
      expect(first.runtime.prompts.map((p) => p.text)).not.toContain("/usage");
      // a person may be typing in an interactive run's pane
      const interactive = await settleCursorTurn(new UsageTracker({ file: null }), true, true);
      expect(interactive.runtime.prompts.map((p) => p.text)).not.toContain("/usage");

      const empty = new UsageTracker({ file: null });
      const second = await settleCursorTurn(empty, false);
      expect(second.settled.state).toBe("idle");
      expect(second.runtime.interrupts).toBe(1);
      expect(empty.list()).toEqual([]);
    });
  });
});

describe("registry", () => {
  it("keeps runs across a restart without their output, and drops week-old ones", async () => {
    const { fleet, root } = setup();
    const run = await spawn(fleet);
    const reloaded = new RunRegistry(join(root, "runs.json"));
    expect(reloaded.get(run.id)).toMatchObject({ id: run.id, state: "working" });
    expect(reloaded.get(run.id)?.lastOutput).toBeUndefined();
    expect(new RunRegistry(join(root, "runs.json"), Date.now() + 8 * 24 * 3_600_000).all()).toEqual([]);
  });
});

describe("result files", () => {
  const settle = async (fleet: Orchestrator, runtime: FakeRuntime, run: { id: string; paneId: string }) => {
    const waiting = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "idle";
    await Bun.sleep(GRACE + 10);
    fleet.onPaneStatus(run.paneId);
    return waiting;
  };
  const resultFileOf = (root: string, id: string) => join(root, "results", id, "handoff.md");

  it("tells the agent a result file in a private folder of its own, and returns what it wrote there", async () => {
    const { fleet, runtime, root } = setup({ agents: [role("reviewer", { interactive: true })] });
    const run = await spawn(fleet, { role: "reviewer" });
    const file = resultFileOf(root, run.id);
    expect(runtime.instructions[0]).toContain(file);
    expect(statSync(join(root, "results", run.id)).mode & 0o777).toBe(0o700);
    writeFileSync(file, "HANDOFF\noutcome: reviewed\n");
    expect((await settle(fleet, runtime, run)).result).toBe("HANDOFF\noutcome: reviewed");
  });

  it("does not hand a follow-up turn the result of the turn before", async () => {
    const { fleet, runtime, root } = setup({ agents: [role("reviewer", { interactive: true })] });
    const run = await spawn(fleet, { role: "reviewer" });
    writeFileSync(resultFileOf(root, run.id), "first");
    expect((await settle(fleet, runtime, run)).result).toBe("first");
    runtime.getStatus = "working";
    await fleet.send(run.id, "again", "g1");
    expect((await settle(fleet, runtime, run)).result).toBeUndefined();
  });

  it("does not fail a turn that wrote its result, whatever error its screen quotes", async () => {
    const { fleet, runtime, root } = setup({ agents: [role("reviewer", { interactive: true })] });
    const run = await spawn(fleet, { role: "reviewer" });
    runtime.output = "Error: tests failed before the fix";
    writeFileSync(resultFileOf(root, run.id), "outcome: fixed");
    expect((await settle(fleet, runtime, run)).state).toBe("idle");
  });

  it("never reads a result through a symlink, and cuts a long one short", async () => {
    const { root } = setup();
    const secret = join(root, "secret");
    writeFileSync(secret, "do not leak");
    symlinkSync(secret, join(root, "link.md"));
    expect(readResult(join(root, "link.md"))).toBeUndefined();
    writeFileSync(join(root, "long.md"), "x".repeat(RESULT_MAX_BYTES + 10));
    expect(readResult(join(root, "long.md"))).toEndWith(`[truncated at ${RESULT_MAX_BYTES} bytes]`);
    expect(readResult(join(root, "missing.md"))).toBeUndefined();
  });

  it("keeps results out of the registry file, and reads them back from the result files after a restart", async () => {
    const { fleet, runtime, root } = setup({ agents: [role("reviewer", { interactive: true })] });
    const run = await spawn(fleet, { role: "reviewer" });
    writeFileSync(resultFileOf(root, run.id), "outcome: kept");
    expect((await settle(fleet, runtime, run)).result).toBe("outcome: kept");
    expect(readFileSync(join(root, "runs.json"), "utf8")).not.toContain("outcome: kept");
    const registry = new RunRegistry(join(root, "runs.json"));
    new Orchestrator({
      runtime, registry, config: () => DEFAULT_CONFIG, agents: () => [], fleetCommand: "fleet", agentEnv: () => ({}), resultsDir: join(root, "results"), instructionsDir: join(root, "instructions"), promptDir: root,
    });
    expect(registry.get(run.id)?.result).toBe("outcome: kept");
  });

  it("removes the result folders of runs the registry no longer has", async () => {
    const { fleet, runtime, registry, root } = setup();
    const run = await spawn(fleet);
    mkdirSync(join(root, "results", "gone1"));
    new Orchestrator({
      runtime, registry, config: () => DEFAULT_CONFIG, agents: () => [], fleetCommand: "fleet", agentEnv: () => ({}), resultsDir: join(root, "results"), instructionsDir: join(root, "instructions"), promptDir: root,
    });
    expect(readdirSync(join(root, "results"))).toEqual([run.id]);
  });
});

describe("agent kinds", () => {
  it("leads the first prompt with the instructions for a CLI that takes none at launch, and only the first", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { agent: "cursor", interactive: true })] });
    runtime.output = "→ Plan, search, build anything";
    const run = await spawn(fleet);
    expect(runtime.starts[0]!.kind).toBe("cursor");
    expect(runtime.prompts[0]!.text).toStartWith("You are worker.");
    expect(runtime.prompts[0]!.text).toEndWith("## Task\n\ndo it");
    await fleet.send(run.id, "next", "g1");
    expect(runtime.prompts[1]!.text).toBe("next");
  });

  it("waits for a CLI herdr calls ready too early to draw its input, and blocks on a question it draws instead", async () => {
    const drawn = setup({ agents: [role("worker", { agent: "cursor" })] });
    drawn.runtime.output = "❯ cursor-agent";
    setTimeout(() => { drawn.runtime.output = "→ Plan, search, build anything"; }, 100);
    expect((await spawn(drawn.fleet)).state).toBe("working");
    expect(drawn.runtime.prompts).toHaveLength(1);

    const asked = setup({ agents: [role("worker", { agent: "cursor" })] });
    asked.runtime.output = "❯ cursor-agent";
    setTimeout(() => { asked.runtime.output = "⚠ Workspace Trust Required\n▶ [a] Trust this workspace"; }, 100);
    expect(await spawn(asked.fleet)).toMatchObject({ state: "blocked" });
    expect(asked.runtime.prompts).toEqual([]);
  });

  it("keeps a run blocked on a question herdr reports as idle when it is read back, until the question goes", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { agent: "cursor" })] });
    runtime.output = "⚠ Workspace Trust Required";
    runtime.getStatus = "idle";
    const run = await spawn(fleet);
    expect(run.state).toBe("blocked");
    expect((await fleet.wait(run.id, 500, "g1")).state).toBe("blocked");
    runtime.output = "→ Plan, search, build anything";
    expect((await fleet.wait(run.id, 500, "g1")).state).toBe("idle");
  });

  it("does not send the task to a CLI that never drew its input", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { agent: "cursor" })] });
    runtime.output = "❯ cursor-agent";
    runtime.getStatus = "idle";
    const run = await spawn(fleet);
    expect(run.lastError).toContain("not ready for prompts");
    expect(runtime.prompts).toEqual([]);
  });

  it("keeps the instructions for the first prompt a person sends after a block at startup", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { agent: "agy" })] });
    runtime.output = "Do you trust the contents of this project?\n> Yes, I trust this folder";
    const run = await spawn(fleet);
    expect(run).toMatchObject({ state: "blocked" });
    expect(run.lastError).toContain("trust this folder");
    expect(runtime.prompts).toEqual([]);
    await fleet.send(run.id, "do it", "g1");
    expect(runtime.prompts[0]!.text).toStartWith("You are worker.");
  });

  it("keeps undelivered instructions across a restart, and drops them once sent", async () => {
    const { fleet, runtime, registry, root } = setup({ agents: [role("worker", { agent: "agy" })] });
    runtime.output = "Do you trust the contents of this project?\n> Yes, I trust this folder";
    const run = await spawn(fleet);
    fleet.stop();
    runtime.output = "──\n>\n──";
    const restarted = new Orchestrator({
      runtime, registry, config: () => DEFAULT_CONFIG, agents: () => [], fleetCommand: "fleet", agentEnv: () => ({}),
      resultsDir: join(root, "results"), instructionsDir: join(root, "instructions"), promptDir: root,
    });
    await restarted.send(run.id, "do it", "g1");
    expect(runtime.prompts[0]!.text).toStartWith("You are worker.");
    expect(readdirSync(join(root, "instructions"))).toEqual([]);
  });

  it("blocks a turn on a question herdr reports as idle, and settles it once the agent is done", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { agent: "agy", interactive: true })] });
    runtime.output = "ready";
    const run = await spawn(fleet);
    const waiting = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "idle";
    runtime.output = "Requesting permission for:\n  ls\nRun this command?";
    await Bun.sleep(GRACE + 10);
    fleet.onPaneStatus(run.paneId);
    expect(await waiting).toMatchObject({ state: "blocked" });
    runtime.getStatus = "working";
    fleet.onPaneStatus(run.paneId);
    await until(() => fleet.get(run.id).state === "working", "working again");
    const settled = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "idle";
    runtime.output = "● done";
    fleet.onPaneStatus(run.paneId);
    expect(await settled).toMatchObject({ state: "idle" });
  });

  it("treats a start that ignored the model as a failed start, so the next model is tried", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { agent: "agy", model: "no-such", fallbackModels: ["gemini-pro"] })] });
    runtime.startImpl = async (options) => {
      runtime.output = options.args.includes("no-such") ? "model no-such is not recognized as a known model or custom model" : "ready";
      return "idle";
    };
    const run = await spawn(fleet);
    expect(run).toMatchObject({ model: "gemini-pro", fallbackFrom: "no-such", state: "working" });
    expect(runtime.closed).toEqual(["w1:p1"]);
  });
});

describe("threads", () => {
  const lead = role("lead", { interactive: true, spawning: true });

  it("start a lead in a workspace named by the title, on a worktree of its own after the user's setup command", async () => {
    const setups: Array<{ cwd: string; command: string }> = [];
    const excluded: string[] = [];
    const { fleet, runtime } = setup({
      agents: [lead], gitRoot: async () => "/repo", config: { projects: { "/repo": { setup: "bun install --ignore-scripts" } } },
      runSetup: async (cwd, command) => { setups.push({ cwd, command }); return { ok: true, output: "" }; },
      excludeWorktrees: async (repo) => { excluded.push(repo); },
    });
    const run = await fleet.startThread({ title: "Fix the retry", task: "Fix the duplicate notification.", cwd: "/repo/src" });
    expect(run).toMatchObject({ role: "lead", name: "Fix the retry", interactive: true, worktree: true, branch: `fleet/${run.id}`, depth: 1 });
    // inside the repository, which the agent CLIs already trust, and out of its git status
    expect(runtime.locations[0]).toMatchObject({ cwd: "/repo/src", label: "Fix the retry", worktree: true, branch: `fleet/${run.id}`, path: `/repo/.herdr-fleet/worktrees/${run.id}` });
    expect(excluded).toEqual(["/repo"]);
    expect(runtime.locations[0]!.callerPaneId).toBeUndefined();
    expect(setups).toEqual([{ cwd: "/repo/src", command: "bun install --ignore-scripts" }]);
    expect(runtime.prompts[0]!.text).toBe("Fix the duplicate notification.");
    // each thread is a fleet of its own
    const second = await fleet.startThread({ title: "Docs", task: "t", cwd: "/repo" });
    expect(second.group).not.toBe(run.group);
  });

  it("belong to the run that starts them, and to the repository they work in", async () => {
    const { fleet } = setup({ agents: [lead, role("coordinator", { interactive: true, spawning: true })], gitRoot: async () => "/repo" });
    const coordinator = await fleet.spawn({ role: "coordinator", task: "coordinate", cwd: "/repo", group: "p1" });
    const thread = await fleet.startThread({ title: "t", cwd: "/repo", depth: 1, callerRun: coordinator.id,
      brief: { goal: "g", write: ["src"], context: "none", done: "d", verify: "v" } });
    expect(thread).toMatchObject({ owner: coordinator.id, project: "/repo", depth: 2 });
    await expect(fleet.startThread({ title: "t", task: "t", callerRun: "nobody" })).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("are listed for their project, with the HANDOFF's status line and the contract's state", async () => {
    const { fleet, registry, root } = setup({ agents: [lead, role("worker")], gitRoot: async (cwd) => cwd.startsWith("/repo") ? "/repo" : null });
    const fixed = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    const fresh = await fleet.startThread({ title: "Docs", task: "t", cwd: "/repo/docs" });
    await fleet.startThread({ title: "Elsewhere", task: "t", cwd: "/other" });
    await spawn(fleet, { cwd: "/repo" });
    registry.upsert({ ...registry.get(fixed.id)!, state: "idle", result: "## HANDOFF\n**PASS** — bun test: 12 pass\nOutcome: fixed" });
    writeFileSync(join(root, "results", fixed.id, "contract.md"), "- [x] A1 no duplicate — evidence: test\n- [ ] A2 docs\n- [!] A3 old clients — evidence: none\n");
    const threads = await fleet.threads({ cwd: "/repo/src" });
    expect(threads.map((t) => t.run.id)).toEqual([fixed.id, fresh.id]);
    expect(threads[0]).toMatchObject({ state: "review", status: "PASS — bun test: 12 pass", contract: [{ id: "A1", state: "met" }, { id: "A2", state: "open" }, { id: "A3", state: "unmet" }] });
    expect(threads[1]!.status).toBeUndefined();
    expect(threads[1]!.contract).toBeUndefined();
  });

  it("stand where their lead and its HANDOFF put them", () => {
    const run = (state: AgentState) => ({ state }) as AgentRun;
    expect(threadState(run("starting"), undefined)).toBe("working");
    expect(threadState(run("working"), "BLOCKED — an earlier turn's")).toBe("working");
    expect(threadState(run("blocked"), undefined)).toBe("waiting");
    expect(threadState(run("idle"), "BLOCKED — which one?")).toBe("waiting");
    expect(threadState(run("idle"), "PASS — 12 pass")).toBe("review");
    expect(threadState(run("done"), "ISSUES — 2 fail")).toBe("idle");
    expect(threadState(run("idle"), undefined)).toBe("idle");
    expect(threadState(run("failed"), "PASS — 12 pass")).toBe("failed");
    expect(threadState(run("stopped"), "PASS — 12 pass")).toBe("ended");
  });

  it("are listed for the calling run's project, wherever it asks from", async () => {
    const { fleet } = setup({ agents: [lead, role("coordinator", { interactive: true, spawning: true })], gitRoot: async (cwd) => cwd.startsWith("/repo") ? "/repo" : null });
    const coordinator = await fleet.startProject({ task: "hello", cwd: "/repo" });
    const thread = await fleet.startThread({ title: "t", task: "t", cwd: "/repo", callerRun: coordinator.id });
    expect((await fleet.threads({ callerRun: coordinator.id, cwd: "/tmp" })).map((t) => t.run.id)).toEqual([thread.id]);
    await expect(fleet.threads({ callerRun: "nobody" })).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("fail before the lead starts when the setup command fails, and close the pane", async () => {
    const { fleet, runtime, registry } = setup({
      agents: [lead], gitRoot: async () => "/repo", config: { projects: { "/repo": { setup: "false" } } },
      runSetup: async () => ({ ok: false, output: "npm ERR! missing script" }),
    });
    const error = await fleet.startThread({ title: "t", task: "t", cwd: "/repo" }).catch((e) => e);
    expect(error).toMatchObject({ code: "setup_failed" });
    expect(error.message).toContain("npm ERR! missing script");
    expect(runtime.starts).toEqual([]);
    expect(runtime.closed).toEqual(["w1:p1"]);
    expect(registry.all()[0]).toMatchObject({ state: "failed" });
  });

  it("work in a plain workspace outside a repository, with no setup and no branch", async () => {
    let setups = 0;
    const { fleet, runtime } = setup({ agents: [lead], runSetup: async () => { setups += 1; return { ok: true, output: "" }; }, config: { projects: { "/notes": { setup: "x" } } } });
    const run = await fleet.startThread({ title: "Notes", task: "t", cwd: "/notes" });
    expect(run.worktree).toBe(false);
    expect(run.branch).toBeUndefined();
    expect(runtime.locations[0]).toMatchObject({ worktree: false, branch: undefined });
    expect(setups).toBe(0);
    await expect(fleet.startThread({ title: " ", task: "t" })).rejects.toMatchObject({ code: "invalid_title" });
  });
});

describe("projects", () => {
  const coordinator = role("coordinator", { model: "claude:sonnet", interactive: true, spawning: true, edits: false });

  it("start the coordinator in the repository's main checkout, in a workspace named after it, editing nothing", async () => {
    const { fleet, runtime } = setup({ agents: [coordinator], gitRoot: async () => "/home/me/app" });
    const run = await fleet.startProject({ task: "What is left to do?", cwd: "/home/me/app/src" });
    expect(run).toMatchObject({ role: "coordinator", name: "app · fleet", agent: "claude", project: "/home/me/app", interactive: true, worktree: false, depth: 1 });
    expect(run.owner).toBeUndefined();
    expect(runtime.locations[0]).toMatchObject({ cwd: "/home/me/app", label: "app · fleet", worktree: false });
    expect(runtime.locations[0]!.callerPaneId).toBeUndefined();
    expect(runtime.starts[0]!.args.join(" ")).toContain("--disallowedTools Edit,Write,NotebookEdit");
    expect(runtime.prompts[0]!.text).toBe("What is left to do?");
    // the person reads its reply: it writes no handoff
    expect(runtime.instructions[0]).not.toContain("result file");
    expect(runtime.instructions[0]).not.toContain("HANDOFF");
  });

  it("keep one coordinator per project: a second start hands it the task, even when both come at once", async () => {
    const { fleet, runtime, registry } = setup({ agents: [coordinator], gitRoot: async (cwd) => cwd.startsWith("/repo") ? "/repo" : null });
    const [first, again] = await Promise.all([fleet.startProject({ task: "one", cwd: "/repo" }), fleet.startProject({ task: "two", cwd: "/repo/src" })]);
    expect(again.id).toBe(first.id);
    expect(runtime.locations).toHaveLength(1);
    expect(runtime.prompts.map((p) => p.text)).toEqual(["one", "two"]);
    // another folder is another project; a coordinator that ended is replaced
    const notes = await fleet.startProject({ task: "three", cwd: "/notes" });
    expect(notes).toMatchObject({ project: "/notes", name: "notes · fleet" });
    registry.upsert({ ...registry.get(first.id)!, state: "stopped" });
    expect((await fleet.startProject({ task: "four", cwd: "/repo" })).id).not.toBe(first.id);
  });

  it("need a task", async () => {
    const { fleet } = setup({ agents: [coordinator] });
    await expect(fleet.startProject({ task: " " })).rejects.toMatchObject({ code: "missing_task" });
  });
});

describe("thread questions", () => {
  const agents = [role("coordinator", { interactive: true, spawning: true }), role("lead", { interactive: true, spawning: true })];

  function project() {
    const states = new Map<string, AgentState>();
    const harness = setup({ agents, gitRoot: async () => "/repo" });
    harness.runtime.getImpl = async (name) => states.get(name) ?? "working";
    /** herdr says `state` for the run's pane, and sends the event */
    const turn = async (run: AgentRun, state: AgentState) => {
      states.set(run.herdrName, state);
      await Bun.sleep(GRACE + 5);
      harness.fleet.onPaneStatus(run.paneId);
      await Bun.sleep(20);
    };
    const toCoordinator = (coordinator: AgentRun) => harness.runtime.prompts.filter((p) => p.name === coordinator.herdrName).map((p) => p.text);
    const handoff = (run: AgentRun, text: string, contract?: string) => {
      writeFileSync(join(harness.root, "results", run.id, "handoff.md"), text);
      if (contract) writeFileSync(join(harness.root, "results", run.id, "contract.md"), contract);
    };
    return { ...harness, states, turn, toCoordinator, handoff };
  }

  const asks = (run: AgentRun, handoff: string) => `- "${run.name}" (${run.id}, fleet/${run.id}) asks the person:\n${handoff.split("\n").map((line) => `  ${line}`).join("\n")}`;
  const HEADER = "[fleet] Threads ask the person. These come from the fleet, not from the person.";

  it("reach the coordinator once it is free, with the whole HANDOFF", async () => {
    const { fleet, registry, turn, toCoordinator, handoff } = project();
    const coordinator = await fleet.startProject({ task: "fix the retry", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const text = "## HANDOFF\nBLOCKED — keep the old retry API?\nOptions: A keep it (recommended), B drop it\nArchitect: callers in two packages use it";
    handoff(thread, text);
    await turn(thread, "idle");
    expect(toCoordinator(coordinator)).toEqual(["fix the retry", [HEADER, asks(thread, text)].join("\n")]);
    expect(registry.get(thread.id)!.notice).toBeUndefined();
  });

  it("are only questions: a PASS, an ISSUES, a failure and a wait on the screen go to the thread list and push notifications", async () => {
    const { fleet, registry, turn, toCoordinator, handoff, states } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const done = await fleet.startThread({ title: "Done", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const issues = await fleet.startThread({ title: "Issues", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const silent = await fleet.startThread({ title: "Silent", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const screen = await fleet.startThread({ title: "Screen", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const ended = await fleet.startThread({ title: "Ended", task: "t", cwd: "/repo", callerRun: coordinator.id });
    handoff(done, "PASS — bun test: 12 pass");
    handoff(issues, "ISSUES — 2 tests fail");
    await turn(done, "idle");
    await turn(issues, "idle");
    await turn(silent, "idle");
    await turn(screen, "blocked");
    fleet.onPaneEnded(ended.paneId);
    states.set(coordinator.herdrName, "idle");
    await turn(coordinator, "idle");
    expect(toCoordinator(coordinator)).toEqual(["go"]);
    for (const run of [done, issues, silent, screen, ended]) expect(registry.get(run.id)!.notice).toBeUndefined();
  });

  it("wait while the coordinator works, its own turn or the person's, and then go out together", async () => {
    const { fleet, registry, turn, toCoordinator, handoff } = project();
    const coordinator = await fleet.startProject({ task: "two things", cwd: "/repo" });
    const first = await fleet.startThread({ title: "One", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const second = await fleet.startThread({ title: "Two", task: "t", cwd: "/repo", callerRun: coordinator.id });
    handoff(first, "BLOCKED — which log format?");
    handoff(second, "BLOCKED — may the old flag go?");
    await turn(first, "idle");
    await turn(second, "idle");
    // the fleet's own turn is still running
    expect(toCoordinator(coordinator)).toEqual(["two things"]);
    expect(registry.get(first.id)!.notice).toContain("BLOCKED — which log format?");
    await turn(coordinator, "idle");
    expect(toCoordinator(coordinator)[1]).toBe([HEADER, asks(first, "BLOCKED — which log format?"), asks(second, "BLOCKED — may the old flag go?")].join("\n"));
    await turn(coordinator, "idle");
    // the person typed in its pane: herdr says working, with no turn of the fleet's
    await turn(coordinator, "working");
    await fleet.send(first.id, "JSON");
    handoff(first, "BLOCKED — one file or one per day?");
    await turn(first, "idle");
    expect(toCoordinator(coordinator)).toHaveLength(2);
    await turn(coordinator, "idle");
    expect(toCoordinator(coordinator)).toEqual([expect.anything(), expect.anything(), [HEADER, asks(first, "BLOCKED — one file or one per day?")].join("\n")]);
  });

  it("wait while the person has a draft in the coordinator's input, and go out once it is gone", async () => {
    const states = new Map<string, AgentState>();
    const { fleet, runtime, root } = setup({
      agents: [role("coordinator", { agent: "claude", interactive: true, spawning: true }), role("lead", { interactive: true, spawning: true })],
      gitRoot: async () => "/repo", draftRetryMs: 30,
    });
    runtime.getImpl = async (name) => states.get(name) ?? "working";
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    states.set(coordinator.herdrName, "idle");
    runtime.screens.set(coordinator.herdrName, "❯\u00a0and also the do");
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(coordinator.paneId);
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    writeFileSync(join(root, "results", thread.id, "handoff.md"), "BLOCKED — which one?");
    states.set(thread.herdrName, "idle");
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(thread.paneId);
    await Bun.sleep(80);
    const toCoordinator = () => runtime.prompts.filter((p) => p.name === coordinator.herdrName).map((p) => p.text);
    expect(toCoordinator()).toEqual(["go"]);
    runtime.screens.set(coordinator.herdrName, "❯\u00a0\x1b[2mTry \"fix lint errors\"\x1b[0m");
    await Bun.sleep(80);
    expect(toCoordinator()).toHaveLength(2);
    expect(toCoordinator()[1]).toContain("BLOCKED — which one?");
    fleet.stop();
  });

  it("carry a long HANDOFF cut, the rest left in the result file", async () => {
    const { fleet, registry, turn, handoff } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    handoff(thread, `BLOCKED — which one?\n${"x".repeat(5000)}`);
    await turn(thread, "idle");
    const notice = registry.get(thread.id)!.notice!;
    expect(notice).toEndWith("[cut at 4000 characters]");
    expect(notice.length).toBeLessThan(4200);
  });

  it("are kept while no coordinator lives, for the project's next one", async () => {
    const { fleet, registry, turn, toCoordinator, handoff } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    fleet.onPaneEnded(coordinator.paneId);
    handoff(thread, "BLOCKED — which one?");
    await turn(thread, "idle");
    expect(registry.get(thread.id)!.notice).toContain("BLOCKED — which one?");
    const next = await fleet.startProject({ task: "and now?", cwd: "/repo" });
    expect(toCoordinator(next)).toEqual(["and now?"]);
    await turn(next, "idle");
    expect(toCoordinator(next)[1]).toBe([HEADER, asks(thread, "BLOCKED — which one?")].join("\n"));
    expect(registry.get(thread.id)!.notice).toBeUndefined();
  });

  it("are kept across a restart", async () => {
    const { fleet, registry, turn, root, handoff } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    handoff(thread, "BLOCKED — which one?");
    await turn(thread, "idle");
    fleet.stop();
    const reloaded = new RunRegistry(join(root, "runs.json"));
    expect(reloaded.get(thread.id)!.notice).toBe(registry.get(thread.id)!.notice);
    expect(reloaded.get(thread.id)!.notice).toContain("asks the person");
  });
});

describe("owners", () => {
  it("reach a thread they started from their own fleet, and no one else's", async () => {
    const { fleet, runtime } = setup({ agents: [role("coordinator", { interactive: true, spawning: true }), role("lead", { interactive: true })], gitRoot: async () => "/repo" });
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const loose = await fleet.startThread({ title: "Other", task: "t", cwd: "/repo" });
    runtime.getStatus = "idle";
    await fleet.send(thread.id, "keep the old API", coordinator.group);
    expect(runtime.prompts.at(-1)).toEqual({ name: thread.herdrName, text: "keep the old API" });
    expect(() => fleet.get(loose.id, coordinator.group)).toThrow("Unknown fleet agent");
    expect(() => fleet.get(thread.id, "elsewhere")).toThrow("Unknown fleet agent");
  });
});
