import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { DEFAULT_CONFIG, mergeConfig } from "./config.ts";
import { AgentWaitTimeoutError, applyModelPolicy, Orchestrator, readResult, RESULT_MAX_BYTES, type LandingTools } from "./orchestrator.ts";
import type { FleetEvent } from "./events.ts";
import { RunRegistry } from "./registry.ts";
import { abortableDelay, abortError, FleetError, type AgentMetadata, type AgentRuntime, type CreateLocationOptions, type RuntimeLocation, type StartOptions } from "./runtime.ts";
import type { AgentDefinition, AgentRun, AgentState, FleetConfig } from "./types.ts";
import { UsageTracker } from "./usage.ts";
import type { ModelCatalog } from "./models.ts";
import { threadState } from "../../shared/fleet.ts";

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
  gitHead?: (cwd: string) => Promise<string | null>;
  diffStat?: (cwd: string, base: string) => Promise<{ added: number; removed: number; files: number } | null>;
  landing?: Partial<LandingTools>;
  models?: Pick<ModelCatalog, "unknown">;
  quietMs?: number;
  events?: (event: FleetEvent) => void;
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
    usage: options.usage, models: options.models, usageScreenMs: 300, gitRoot: options.gitRoot ?? (async () => null), runSetup: options.runSetup, excludeWorktrees: options.excludeWorktrees ?? (async () => {}), standingOrders: options.standingOrders,
    draftRetryMs: options.draftRetryMs, quietMs: options.quietMs, events: options.events, gitHead: options.gitHead ?? (async () => null), diffStat: options.diffStat,
    landing: { gitBranch: async () => null, readPullRequest: async () => null, ...options.landing },
  });
  return { fleet, runtime, registry, root };
}

const spawn = (fleet: Orchestrator, extra: Record<string, unknown> = {}) => fleet.spawn({ role: "worker", task: "do it", group: "g1", cwd: "/work", ...extra });
/** what an agent writes as its turn's report: report.json beside its handoff */
const writeReport = (root: string, id: string, state: string, summary: string, human_action?: string) =>
  writeFileSync(join(root, "results", id, "report.json"), JSON.stringify({ state, summary, evidence: [], ...(human_action ? { human_action } : {}) }));
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
    // the outcome is a report file the fleet reads, not a status line in prose
    expect(runtime.instructions[0]).toContain(`Your report file is ${join(root, "results", run.id, "report.json")}.`);
    expect(runtime.instructions[0]).toContain('"state": progress, waiting, ready, blocked, failed or dropped');
    expect(runtime.instructions[0]).not.toMatch(/PASS|ISSUES|BLOCKED/);
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

  it("records the role file a run starts with, its version and the standing orders' version, after the run's first state", async () => {
    const events: FleetEvent[] = [];
    // expected hashes: `printf '<text>' | sha256sum`, first 12 hex digits
    const { fleet } = setup({ agents: [role("worker", { source: "user", filePath: "/u/worker.md", hash: "0123456789ab" })], standingOrders: () => "1. Ask before a push.", events: (event) => events.push(event) });
    const run = await spawn(fleet);
    expect(events.filter((e) => e.run === run.id).slice(0, 2)).toEqual([
      expect.objectContaining({ kind: "state", to: "starting" }),
      { kind: "role", run: run.id, role: "worker", source: "user", file: "/u/worker.md", hash: "0123456789ab", standing: "edb086f7d809" },
    ]);
    const bare = setup({ agents: [role("lead")], standingOrders: () => "", events: (event) => events.push(event) });
    const lead = await bare.fleet.spawn({ role: "lead", task: "do it", group: "g2", cwd: "/work" });
    expect(events.find((e) => e.kind === "role" && e.run === lead.id)).toEqual({ kind: "role", run: lead.id, role: "lead", source: "bundled", file: "lead.md", hash: "8bbc2266f7e2" });
  });

  it("tells every agent the person's language when the config sets one, and writes no section without it", async () => {
    const { fleet, runtime } = setup({ config: { language: "Japanese" } });
    await spawn(fleet);
    expect(runtime.instructions[0]).toContain("## The person's language");
    expect(runtime.instructions[0]).toContain("The person reads Japanese. Write in Japanese what the person reads: your replies to the person, a plan, a question for the person");
    expect(runtime.instructions[0]).toContain("Write tasks and messages for other agents in English.");
    const bare = setup();
    await spawn(bare.fleet);
    expect(bare.runtime.instructions[0]).not.toContain("The person reads");
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
  it("settles a turn when herdr reports it finished, hands the output to the waiter, and closes a non-interactive pane that wrote its report", async () => {
    const { fleet, runtime, root } = setup();
    const run = await spawn(fleet);
    const waiting = fleet.wait(run.id, 2000, "g1");
    writeFileSync(join(root, "results", run.id, "handoff.md"), "PASS — done");
    writeFileSync(join(root, "results", run.id, "report.json"), JSON.stringify({ state: "ready", summary: "Done.", evidence: [] }));
    runtime.getStatus = "done";
    runtime.output = "work\nHANDOFF: done";
    fleet.onPaneStatus(run.paneId);
    const settled = await waiting;
    expect(settled).toMatchObject({ state: "done", lastOutput: "work\nHANDOFF: done", result: "PASS — done" });
    await until(() => fleet.get(run.id).state === "stopped", "pane closed");
    expect(runtime.closed).toEqual([run.paneId]);
  });

  it("keeps the pane of a non-interactive turn that ended without its handoff, so what stopped it can be seen and the run sent on", async () => {
    // a question the adapter does not know (agy's file access screen before it did) reads as a finished turn
    const { fleet, runtime } = setup();
    const run = await spawn(fleet);
    const waiting = fleet.wait(run.id, 2000, "g1");
    runtime.getStatus = "done";
    runtime.output = "Allow access to this file?";
    fleet.onPaneStatus(run.paneId);
    expect(await waiting).toMatchObject({ state: "done", lastOutput: "Allow access to this file?" });
    expect((await waiting).result).toBeUndefined();
    await Bun.sleep(20);
    expect(runtime.closed).toEqual([]);
    expect(fleet.get(run.id).state).toBe("done");
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

describe("a model the CLI does not offer", () => {
  const offers = (...names: string[]) => ({ unknown: async (agent: string, model?: string) => (model && !names.includes(model) ? `${agent} does not offer a model named ${model}` : undefined) });

  it("is passed over for the next candidate before any pane opens", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { model: "p/primary", fallbackModels: ["codex:gpt-6"] })], models: offers("gpt-6") });
    const run = await spawn(fleet);
    expect(run).toMatchObject({ agent: "codex", model: "gpt-6", fallbackFrom: "p/primary" });
    expect(run.skipped).toEqual([{ candidate: "p/primary", reason: "pi does not offer a model named p/primary" }]);
    expect(runtime.locations).toHaveLength(1);
  });

  it("refuses the spawn, with every reason, when no candidate is left", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { model: "nope" })], models: offers() });
    const error = await spawn(fleet).catch((e) => e);
    expect(error).toMatchObject({ code: "no_candidates" });
    expect(error.message).toContain("nope: pi does not offer a model named nope");
    expect(runtime.locations).toEqual([]);
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
    expect(runtime.instructions[0]).toContain("your file-editing tools are off: write your result file and your report file with a shell command");
  });

  it("holds a pi role that edits nothing with pi's own denylist, whatever tools the role lists", async () => {
    const { fleet, runtime } = setup({ agents: [role("keeper", { agent: "pi", model: "p/primary", tools: ["read", "bash", "edit", "write"], edits: false, interactive: true, spawning: true })] });
    const run = await spawn(fleet, { role: "keeper" });
    expect(run).toMatchObject({ agent: "pi", interactive: true });
    const args = runtime.starts[0]!.args;
    expect(args.join(" ")).toContain("--exclude-tools edit,write");
    expect(args.indexOf("--exclude-tools")).toBeGreaterThan(args.indexOf("--tools"));
    expect(runtime.instructions[0]).toContain("your file-editing tools are off");
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
      const { fleet, runtime, root } = setup({ agents: [role("worker", { agent: "cursor", interactive })], usage });
      runtime.output = INPUT;
      const run = await spawn(fleet);
      // a turn that wrote its report: only such a turn's pane closes on settle
      writeFileSync(join(root, "results", run.id, "report.json"), JSON.stringify({ state: "ready", summary: "Done.", evidence: [] }));
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

  it("does not fail a turn that wrote its report, whatever error its screen quotes", async () => {
    const { fleet, runtime, root } = setup({ agents: [role("reviewer", { interactive: true })] });
    const run = await spawn(fleet, { role: "reviewer" });
    runtime.output = "Error: tests failed before the fix";
    writeFileSync(join(root, "results", run.id, "report.json"), JSON.stringify({ state: "ready", summary: "Fixed.", evidence: [] }));
    expect((await settle(fleet, runtime, run)).state).toBe("idle");
  });

  it("takes a turn's outcome from report.json alone, and calls a turn without one 'no report', whatever its handoff says", async () => {
    const events: FleetEvent[] = [];
    const { fleet, runtime, root } = setup({ agents: [role("reviewer", { interactive: true })], events: (event) => events.push(event) });
    const run = await spawn(fleet, { role: "reviewer" });
    writeFileSync(resultFileOf(root, run.id), "## HANDOFF\nPASS — no findings");
    expect((await settle(fleet, runtime, run)).outcome).toEqual({ report: null, problem: "report.json is missing." });
    runtime.getStatus = "working";
    await fleet.send(run.id, "again", "g1");
    writeFileSync(join(root, "results", run.id, "report.json"), JSON.stringify({ state: "ready", summary: "Reviewed.", evidence: ["no findings"] }));
    expect((await settle(fleet, runtime, run)).outcome).toEqual({ report: { state: "ready", summary: "Reviewed.", evidence: ["no findings"] } });
    // the next turn starts without the report of the one before
    runtime.getStatus = "working";
    await fleet.send(run.id, "and again", "g1");
    expect((await settle(fleet, runtime, run)).outcome).toEqual({ report: null, problem: "report.json is missing." });
    expect(events.filter((e) => e.kind === "turn").map((e) => e.kind === "turn" && e.report)).toEqual(["none", "ready", "none"]);
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

  it("starts opencode standalone with its config in the pane, and holds a read-only role to its result file and its commands", async () => {
    const { fleet, runtime, root } = setup({ agents: [role("auditor", { agent: "opencode", model: "p/m", edits: false, interactive: true })] });
    const run = await spawn(fleet, { role: "auditor" });
    const env = runtime.locations[0]!.env;
    expect(env).toMatchObject({ HERDR_FLEET_GROUP: "g1", HERDR_FLEET_URL: "http://127.0.0.1:1", OPENCODE_DISABLE_AUTOUPDATE: "true" });
    const config = JSON.parse(env["OPENCODE_CONFIG_CONTENT"]!);
    expect(config).toMatchObject({ model: "p/m", share: "disabled", update: "disable", default_agent: "fleet-readonly" });
    expect(config.agents["fleet-readonly"].permissions).toContainEqual({ action: "edit", resource: `${join(root, "results")}/${run.id}/*`, effect: "allow" });
    expect(runtime.starts[0]).toMatchObject({ kind: "opencode", args: ["--standalone"] });
    expect(runtime.prompts[0]!.text).toContain("write them with your file-editing tool, which is limited to their folder");
    expect(runtime.prompts[0]!.text).toContain("git diff --no-ext-diff --no-textconv");
    expect(runtime.prompts[0]!.text).not.toContain("gh pr merge");
  });

  it("gives opencode's editing roles no read-only agent, and only the project's coordinator the merge commands", async () => {
    const editing = setup({ agents: [role("worker", { agent: "opencode", model: "p/m" })] });
    await spawn(editing.fleet);
    const config = JSON.parse(editing.runtime.locations[0]!.env["OPENCODE_CONFIG_CONTENT"]!);
    expect(config.default_agent).toBeUndefined();
    expect(config.agents).toBeUndefined();
    expect(config.permissions).toContainEqual({ action: "shell", resource: "git *push* --force*", effect: "deny" });
    expect(editing.runtime.prompts[0]!.text).not.toContain("Your shell runs only");
    const merging = setup({ agents: [role("coordinator", { agent: "opencode", model: "p/m", edits: false, interactive: true })] });
    await spawn(merging.fleet, { role: "coordinator" });
    const rules = JSON.parse(merging.runtime.locations[0]!.env["OPENCODE_CONFIG_CONTENT"]!).agents["fleet-readonly"].permissions;
    expect(rules).toContainEqual({ action: "shell", resource: "git pull --ff-only", effect: "allow" });
    expect(merging.runtime.prompts[0]!.text).toContain("gh pr merge <number> --merge");
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

  it("tells an agent on agy that its sandboxed terminal runs no git, no project tool and no fleet command, and no other CLI's agent", async () => {
    const { fleet, runtime } = setup({ agents: [role("worker", { agent: "agy" }), role("reviewer", { agent: "claude" })] });
    runtime.output = "──\n>\n──\n? for shortcuts    auto · Gemini 4 Argon · medium";
    await spawn(fleet);
    expect(runtime.prompts[0]!.text).toContain("Your terminal runs in Antigravity CLI's sandbox");
    await spawn(fleet, { role: "reviewer" });
    expect(runtime.instructions.join("\n")).not.toContain("Antigravity CLI's sandbox");
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
    // agy is ready once its input shows and the auto mode from its settings is set
    runtime.output = ">\n? for shortcuts    auto · Gemini 4 Argon · medium";
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

  it("are listed for their project, with the last report and the contract's state", async () => {
    const { fleet, registry, root } = setup({ agents: [lead, role("worker")], gitRoot: async (cwd) => cwd.startsWith("/repo") ? "/repo" : null });
    const fixed = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    const fresh = await fleet.startThread({ title: "Docs", task: "t", cwd: "/repo/docs" });
    await fleet.startThread({ title: "Elsewhere", task: "t", cwd: "/other" });
    await spawn(fleet, { cwd: "/repo" });
    registry.upsert({ ...registry.get(fixed.id)!, state: "idle", result: "## HANDOFF\nOutcome: fixed", outcome: { report: { state: "ready", summary: "bun test: 12 pass", evidence: [] } } });
    writeFileSync(join(root, "results", fixed.id, "contract.md"), "- [x] A1 no duplicate — evidence: test\n- [ ] A2 docs\n- [!] A3 old clients — evidence: none\n");
    const threads = await fleet.threads({ cwd: "/repo/src" });
    expect(threads.map((t) => t.run.id)).toEqual([fixed.id, fresh.id]);
    expect(threads[0]).toMatchObject({ state: "review", status: "ready — bun test: 12 pass", contract: [{ id: "A1", state: "met" }, { id: "A2", state: "open" }, { id: "A3", state: "unmet" }] });
    expect(threads[1]!.status).toBeUndefined();
    expect(threads[1]!.contract).toBeUndefined();
  });

  it("carry what the lead's turn left: the contract, and the change since the commit the worktree started from", async () => {
    const diffs: Array<{ cwd: string; base: string }> = [];
    const { fleet, registry, runtime, root } = setup({
      agents: [lead], gitRoot: async () => "/repo", gitHead: async () => "abc1234",
      diffStat: async (cwd, base) => { diffs.push({ cwd, base }); return { added: 24, removed: 9, files: 2 }; },
    });
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    expect(thread.base).toBe("abc1234");
    writeFileSync(join(root, "results", thread.id, "handoff.md"), "PASS — done");
    writeFileSync(join(root, "results", thread.id, "contract.md"), "- [x] A1 fixed\n- [ ] A2 docs\n");
    runtime.getStatus = "idle";
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(thread.paneId);
    await Bun.sleep(30);
    expect(registry.get(thread.id)).toMatchObject({ contract: [{ id: "A1", state: "met" }, { id: "A2", state: "open" }], diff: { added: 24, removed: 9, files: 2 } });
    expect(diffs).toEqual([{ cwd: thread.cwd, base: "abc1234" }]);
  });

  it("are marked done by the person, and open again once their lead works again", async () => {
    const { fleet, registry, runtime } = setup({ agents: [lead, role("worker")], gitRoot: async () => "/repo" });
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    runtime.getStatus = "idle";
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(thread.paneId);
    await Bun.sleep(20);
    expect(fleet.resolve(thread.id, true).resolvedAt).toBeNumber();
    expect(fleet.resolve(thread.id, false).resolvedAt).toBeUndefined();
    fleet.resolve(thread.id, true);
    runtime.getStatus = "working";
    fleet.onPaneStatus(thread.paneId);
    await Bun.sleep(20);
    expect(registry.get(thread.id)!.resolvedAt).toBeUndefined();
    const helper = await spawn(fleet);
    expect(() => fleet.resolve(helper.id, true, helper.group)).toThrow("is not a thread's lead");
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

  describe("read a lead's turn once, whatever herdr's state does as it settles", () => {
    const HANDOFF = "## HANDOFF\nPASS — the retry sends one notification";
    // herdr's states as run 4bff4935 showed them on 2026-11-08: done, then working and done again 9 s later
    const flicker = async (fleet: Orchestrator, runtime: FakeRuntime) => {
      for (const state of ["done", "working", "done"] as const) {
        runtime.getStatus = state;
        await fleet.reconcileAll();
      }
    };

    it("after a done-working-done flicker", async () => {
      const events: FleetEvent[] = [];
      const { fleet, runtime, registry, root } = setup({ agents: [lead], gitRoot: async () => "/repo", events: (event) => events.push(event) });
      const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
      writeFileSync(join(root, "results", thread.id, "handoff.md"), HANDOFF);
      await flicker(fleet, runtime);
      expect(events.filter((event) => event.kind === "turn")).toEqual([expect.objectContaining({ run: thread.id, handoff: true })]);
      expect(registry.get(thread.id)).toMatchObject({ state: "done", result: HANDOFF });
    });

    /** A thread whose task the fleet sent, then a new server over the same registry file, as after a restart. */
    const restartAfterSend = async (promptStatus: AgentState = "working") => {
      const { fleet, runtime, root } = setup({ agents: [lead], gitRoot: async () => "/repo" });
      runtime.promptStatus = promptStatus;
      const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
      fleet.stop();
      return {
        fleet, runtime, thread, handoffFile: join(root, "results", thread.id, "handoff.md"),
        restart: () => {
          const events: FleetEvent[] = [];
          const registry = new RunRegistry(join(root, "runs.json"));
          const restarted = new Orchestrator({
            runtime, registry, config: () => DEFAULT_CONFIG, agents: () => [lead], fleetCommand: "fleet", agentEnv: () => ({}), resultsDir: join(root, "results"), instructionsDir: join(root, "instructions"), promptDir: root,
            preVisualGraceMs: GRACE, gitHead: async () => null, diffStat: async () => null, landing: { gitBranch: async () => null, readPullRequest: async () => null }, events: (event) => events.push(event),
          });
          return { restarted, registry, turns: () => events.filter((event) => event.kind === "turn") };
        },
      };
    };

    it("when the fleet server restarted while the turn was running", async () => {
      const { runtime, thread, handoffFile, restart } = await restartAfterSend();
      const { restarted, registry, turns } = restart();
      writeFileSync(handoffFile, HANDOFF);
      await flicker(restarted, runtime);
      expect(turns()).toEqual([expect.objectContaining({ run: thread.id, handoff: true })]);
      expect(registry.get(thread.id)).toMatchObject({ state: "done", result: HANDOFF });
      restarted.stop();
    });

    it("when the turn ended while the fleet server was down", async () => {
      const { runtime, thread, handoffFile, restart } = await restartAfterSend();
      runtime.getStatus = "done";
      writeFileSync(handoffFile, HANDOFF);
      const { restarted, registry, turns } = restart();
      // as the server does as it starts (server/index.ts); herdr sends no event for a state that
      // changed before the server came up, so a reading too early to trust is followed by another
      await restarted.reconcileAll();
      await until(() => turns().length > 0, "the turn read after the restart");
      await Bun.sleep(GRACE * 2);
      expect(turns()).toEqual([expect.objectContaining({ run: thread.id, handoff: true })]);
      expect(registry.get(thread.id)).toMatchObject({ state: "done", result: HANDOFF });
      restarted.stop();
    });

    it("and keep the plan that turn wrote before the restart open for the person's answers", async () => {
      const { fleet, runtime, thread, handoffFile, restart } = await restartAfterSend();
      fleet.submitPlan(thread.id, { title: "Retry limit", claims: [{ text: "A failed send is tried three times.", exhibit: { kind: "list", items: ["three"] } }] });
      await Bun.sleep(5);
      const { restarted, registry } = restart();
      writeFileSync(handoffFile, "## HANDOFF\nBLOCKED — the plan waits for the person");
      await flicker(restarted, runtime);
      expect(registry.get(thread.id)!.plan).toMatchObject({ version: 1 });
      expect(registry.get(thread.id)!.plan!.closedAt).toBeUndefined();
      restarted.stop();
    });

    it("not before herdr shows the turn, when the server restarted while the prompt was pasted", async () => {
      // herdr still answered with the idle from before the prompt when the last server stopped
      const { runtime, thread, handoffFile, restart } = await restartAfterSend("idle");
      runtime.getStatus = "idle";
      const { restarted, registry, turns } = restart();
      await restarted.reconcileAll();
      expect(turns()).toEqual([]);
      runtime.getStatus = "working";
      await restarted.reconcileAll();
      writeFileSync(handoffFile, HANDOFF);
      runtime.getStatus = "done";
      await restarted.reconcileAll();
      expect(turns()).toEqual([expect.objectContaining({ run: thread.id, handoff: true })]);
      expect(registry.get(thread.id)).toMatchObject({ state: "done", result: HANDOFF });
      restarted.stop();
    });
  });
});

describe("a thread outlives its lead run", () => {
  // the bundled lead's candidates: claude, then codex
  const lead = role("lead", { agent: "claude", fallbackModels: ["codex:"], interactive: true, spawning: true });
  const NOTE = "Check the worktree, git history and GitHub before repeating any outside action (push, PR, comment).";

  function thread(options: SetupOptions = {}) {
    const states = new Map<string, AgentState>();
    const events: FleetEvent[] = [];
    const harness = setup({ agents: [lead, role("coordinator", { agent: "claude", interactive: true, spawning: true })], gitRoot: async () => "/repo", gitHead: async () => "abc1234", events: (event) => events.push(event), ...options });
    harness.runtime.getImpl = async (name) => states.get(name) ?? "working";
    const turn = async (run: AgentRun, state: AgentState) => {
      states.set(run.herdrName, state);
      await Bun.sleep(GRACE + 5);
      harness.fleet.onPaneStatus(run.paneId);
      await Bun.sleep(30);
    };
    const write = (run: AgentRun, file: string, text: string) => writeFileSync(join(harness.root, "results", run.id, file), text);
    const report = (run: AgentRun, value: Record<string, unknown>) => write(run, "report.json", JSON.stringify(value));
    const promptsTo = (run: AgentRun) => harness.runtime.prompts.filter((p) => p.name === run.herdrName).map((p) => p.text);
    return { ...harness, states, events, turn, write, report, promptsTo };
  }

  it("goes on in a new run on another CLI when its lead's turn ended without a report, in the same worktree, with the recovery note", async () => {
    const { fleet, runtime, registry, root, events, turn, write, promptsTo } = thread();
    const first = await fleet.startThread({ title: "Fix", task: "Fix the duplicate notification.", cwd: "/repo" });
    // a HANDOFF that says PASS is prose: without report.json the turn has no report
    write(first, "handoff.md", "## HANDOFF\nPASS — bun test: 12 pass");
    write(first, "contract.md", "- [x] A1 no duplicate — evidence: test\n");
    await turn(first, "idle");
    const old = registry.get(first.id)!;
    expect(old.outcome).toEqual({ report: null, problem: "report.json is missing." });
    expect(old.replacedBy).toBeDefined();
    expect(old.state).toBe("stopped");
    expect(runtime.closed).toContain(first.paneId);
    const next = registry.get(old.replacedBy!)!;
    expect(next).toMatchObject({ role: "lead", name: "Fix", agent: "codex", group: first.group, branch: `fleet/${first.id}`, thread: first.id, project: "/repo", base: "abc1234", cwd: first.cwd, depth: first.depth, state: "working" });
    // no second worktree: the new run opens in the thread's own
    expect(runtime.locations[1]).toMatchObject({ cwd: first.cwd, worktree: false });
    expect(runtime.locations[1]!.path).toBeUndefined();
    const [task] = promptsTo(next);
    expect(task).toStartWith(`[fleet] You take over the thread "Fix" from run ${first.id} on claude, which ended its turn without a report (report.json is missing.). This comes from the fleet, not from the person.`);
    expect(task).toContain(NOTE);
    expect(task).toContain(join(root, "results", first.id));
    expect(task).toContain("The thread's task:\n\nFix the duplicate notification.");
    // its first turn's message was the task: it is not repeated
    expect(task).not.toContain("The fleet's last message");
    expect(readFileSync(join(root, "results", next.id, "contract.md"), "utf8")).toBe("- [x] A1 no duplicate — evidence: test\n");
    // the thread list shows the contract as the turn before left it, while the new run works
    expect(next.contract).toEqual([{ id: "A1", state: "met" }]);
    expect(events.filter((e) => e.kind === "restart")).toEqual([{ kind: "restart", run: first.id, project: "/repo", agent: "claude", why: "no-report", by: next.id, to: "codex" }]);
    // the thread is known by its first id: the fleet's commands and the thread list reach its current lead
    expect(fleet.get(first.id).id).toBe(next.id);
    expect((await fleet.threads({ cwd: "/repo" })).map((t) => t.run.id)).toEqual([next.id]);
  });

  it("goes on in a new run when its lead's run failed, with the fleet's last message, and stops once every CLI of the role failed since its last report", async () => {
    const { fleet, runtime, registry, events, turn, promptsTo } = thread({ agents: [role("lead", { agent: "claude", fallbackModels: ["codex:", "pi:"], interactive: true, spawning: true })] });
    const first = await fleet.startThread({ title: "Fix", task: "Fix it.", cwd: "/repo" });
    await turn(first, "idle");
    const second = registry.get(registry.get(first.id)!.replacedBy!)!;
    await turn(second, "working");
    await fleet.send(second.id, "Also update the docs.");
    // an API failure the CLI gave up on: the run failed
    runtime.output = "■ stream disconnected before completion";
    await turn(second, "idle");
    expect(registry.get(second.id)).toMatchObject({ state: "failed", lastError: "stream disconnected before completion" });
    const third = registry.get(registry.get(second.id)!.replacedBy!)!;
    expect(third).toMatchObject({ agent: "pi", thread: first.id, branch: `fleet/${first.id}`, avoid: ["claude", "codex"] });
    const [task] = promptsTo(third);
    expect(task).toStartWith(`[fleet] You take over the thread "Fix" from run ${second.id} on codex, which failed: stream disconnected before completion.`);
    expect(task).toContain("The thread's task:\n\nFix it.");
    expect(task).toContain("The fleet's last message to the run before:\n\nAlso update the docs.");
    // every CLI of the role failed since the thread's last report: nothing is left to restart on
    runtime.output = "agent output";
    await turn(third, "idle");
    expect(registry.get(third.id)!.replacedBy).toBeUndefined();
    expect(registry.get(third.id)!.state).toBe("idle");
    expect(events.filter((e) => e.kind === "restart").map((e) => e.kind === "restart" && [e.why, e.agent, e.to ?? e.error])).toEqual([
      ["no-report", "claude", "codex"], ["failed", "codex", "pi"],
      ["no-report", "pi", "No candidate is usable: default: the caller keeps claude out; codex:: the caller keeps codex out; pi:: the caller keeps pi out"],
    ]);
    expect(threadState(registry.get(third.id)!)).toBe("waiting");
  });

  it("stays with its lead when the report says ready, blocked, failed or waiting: a failed report waits for the person", async () => {
    const { fleet, registry, turn, report } = thread();
    const runs: AgentRun[] = [];
    for (const state of ["ready", "blocked", "failed", "waiting"]) {
      const run = await fleet.startThread({ title: state, task: "t", cwd: "/repo" });
      report(run, { state, summary: `${state} summary`, evidence: ["bun test"], ...(state === "blocked" ? { human_action: "Keep the old API?" } : {}) });
      await turn(run, "idle");
      runs.push(run);
    }
    expect(runs.map((run) => registry.get(run.id)!.replacedBy)).toEqual([undefined, undefined, undefined, undefined]);
    expect(runs.map((run) => threadState(registry.get(run.id)!))).toEqual(["review", "waiting", "waiting", "idle"]);
  });

  it("hands the thread's pull request and landing step to the new run, so the thread is not landed twice", async () => {
    const removed: string[] = [];
    const git = { state: "OPEN" };
    const { fleet, registry, turn } = thread({ landing: {
      gitBranch: async () => "main", branchHead: async () => "c0ffee",
      readPullRequest: async () => ({ number: 7, url: "https://github.com/o/r/pull/7", state: git.state, checks: "pass", head: "c0ffee" }) as never,
      removeThread: async (_repo, worktree, branch) => { removed.push(`${worktree} ${branch}`); return undefined; },
    } });
    const first = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    Object.assign(registry.get(first.id)!, { pr: { number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", checks: "pass" }, landing: { action: "merge-pr", at: 1, sent: true } });
    await turn(first, "idle");
    const next = registry.get(registry.get(first.id)!.replacedBy!)!;
    expect(next).toMatchObject({ pr: { number: 7, state: "OPEN" }, landing: { action: "merge-pr", sent: true } });
    expect(registry.get(first.id)!.landing).toBeUndefined();
    // the new run's turn ends (no CLI is left to restart it on), then the person merges it on GitHub:
    // the thread closes once, on the run that leads it
    await turn(next, "idle");
    git.state = "MERGED";
    await fleet.refreshPullRequests();
    expect(removed).toEqual([`/repo/.herdr-fleet/worktrees/${first.id} fleet/${first.id}`]);
    expect(registry.get(next.id)!.landed).toBe("merged");
    expect(registry.get(first.id)!.landed).toBeUndefined();
  });

  it("reads no report from a turn its lead started itself and ended without one, though the turn before left one", async () => {
    const { fleet, registry, turn, report } = thread({ config: { autonomous: true } });
    const first = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    report(first, { state: "waiting", summary: "Waiting for the helper.", evidence: [] });
    await turn(first, "idle");
    expect(registry.get(first.id)!.replacedBy).toBeUndefined();
    // the helper's result wakes the lead: the fleet sent nothing, and this turn writes no report
    await turn(first, "working");
    await turn(first, "idle");
    expect(registry.get(first.id)!.outcome).toEqual({ report: null, problem: "report.json is missing." });
    expect(registry.get(first.id)!.replacedBy).toBeDefined();
  });

  it("hands a landing step its lead did not finish to the new run, unjudged, and judges it when that run's turn ends", async () => {
    const git = { pr: null as Record<string, unknown> | null };
    const { fleet, registry, turn, report, promptsTo } = thread({ landing: { gitBranch: async () => "main", readPullRequest: async () => git.pr as never } });
    const first = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    report(first, { state: "ready", summary: "Fixed.", evidence: [] });
    await turn(first, "idle");
    await fleet.land(first.id, "pr");
    // the lead's turn ends without a report, and without the pull request
    await turn(first, "idle");
    const next = registry.get(registry.get(first.id)!.replacedBy!)!;
    expect(next.landing).toMatchObject({ action: "pr", sent: true });
    expect(next.landing!.error).toBeUndefined();
    expect(promptsTo(next)[0]).toContain("The fleet's last message to the run before:\n\n[fleet] The person pressed Create PR");
    git.pr = { number: 70, url: "https://github.com/o/r/pull/70", state: "OPEN", checks: "pending", head: "c0ffee" };
    report(next, { state: "ready", summary: "Opened #70.", evidence: [] });
    await turn(next, "idle");
    expect(registry.get(next.id)!.landing).toBeUndefined();
    expect(registry.get(next.id)!.pr).toMatchObject({ number: 70, state: "OPEN" });
  });

  it("keeps a plan open across a restart: the new run's turn waiting on it does not close it", async () => {
    const tree = mkdtempSync(join(tmpdir(), "fleet-plan-tree-"));
    roots.push(tree);
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, "src", "retry.ts"), "export const RETRIES = 3;\n");
    const { fleet, runtime, registry, root, turn, report } = thread();
    runtime.createLocationImpl = async (options) => ({ paneId: `w1:p${runtime.locations.length}`, cwd: options.worktree ? tree : options.cwd });
    const first = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    fleet.submitPlan(first.id, { title: "Retry limit", claims: [{ text: "A failed send is tried three times.", exhibit: { kind: "code", path: "src/retry.ts", start: 1 } }] });
    // the lead handed over its plan, then its turn ended without a report
    await turn(first, "idle");
    const next = registry.get(registry.get(first.id)!.replacedBy!)!;
    expect(next.plan).toEqual({ version: 1, asks: 0 });
    report(next, { state: "blocked", summary: "The plan waits for the person.", evidence: [], human_action: "Answer the plan in the Plan tab." });
    await turn(next, "idle");
    expect(registry.get(next.id)!.plan!.closedAt).toBeUndefined();
    expect(fleet.plan(first.id).closedAt).toBeUndefined();
    expect(JSON.parse(readFileSync(join(root, "fleet-plans", `${next.id}.json`), "utf8")).closedAt).toBeUndefined();
  });

  it("sends a message for the old run, made while the new run starts, to the new run", async () => {
    const { fleet, runtime, registry, turn, promptsTo } = thread();
    const first = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runtime.createLocationImpl = async (options) => { await gate; return { paneId: "w1:p9", cwd: options.cwd }; };
    const settling = turn(first, "idle");
    await until(() => runtime.locations.length === 2, "the new run's pane asked for");
    const sent = fleet.send(first.id, "Also update the docs.");
    release();
    await settling;
    const next = registry.get(registry.get(first.id)!.replacedBy!)!;
    expect((await sent).id).toBe(next.id);
    expect(promptsTo(next).at(-1)).toBe("Also update the docs.");
  });

  it("hides a candidate that failed to start in a restart behind the run that took the thread over, without the landing step it was handed", async () => {
    const { fleet, runtime, registry, turn } = thread({ agents: [role("lead", { agent: "claude", fallbackModels: ["codex:", "pi:"], interactive: true, spawning: true })] });
    const first = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    // a merge the person pressed waits for the coordinator while the restart runs
    registry.get(first.id)!.landing = { action: "merge", at: 1, sent: false };
    runtime.startImpl = async (options) => { if (options.kind === "codex") throw new FleetError("agent_start_failed", "codex is signed out"); return "idle"; };
    await turn(first, "idle");
    const next = registry.get(registry.get(first.id)!.replacedBy!)!;
    expect(next.agent).toBe("pi");
    const failed = registry.all().find((run) => run.agent === "codex")!;
    expect(failed).toMatchObject({ state: "failed", replacedBy: next.id });
    // only the thread's lead holds the merge: the coordinator is not handed it twice, nor the thread closed on a hidden run
    expect(registry.all().filter((run) => run.landing).map((run) => run.id)).toEqual([next.id]);
    expect((await fleet.threads({ cwd: "/repo" })).map((t) => t.run.id)).toEqual([next.id]);
  });

  it("closes a carried plan when the new run went on to a report other than blocked, and keeps it open when a turn failed and no run could take over", async () => {
    const tree = mkdtempSync(join(tmpdir(), "fleet-plan-tree-"));
    roots.push(tree);
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, "src", "retry.ts"), "export const RETRIES = 3;\n");
    const PLAN = { title: "Retry limit", claims: [{ text: "A failed send is tried three times.", exhibit: { kind: "code", path: "src/retry.ts", start: 1 } }] };
    const { fleet, runtime, registry, turn, report } = thread();
    runtime.createLocationImpl = async (options) => ({ paneId: `w1:p${runtime.locations.length}`, cwd: options.worktree ? tree : options.cwd });
    const first = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    fleet.submitPlan(first.id, PLAN);
    await turn(first, "idle");
    const next = registry.get(registry.get(first.id)!.replacedBy!)!;
    report(next, { state: "ready", summary: "Built it without the answers.", evidence: [] });
    await turn(next, "idle");
    expect(registry.get(next.id)!.plan!.closedAt).toBeNumber();

    // another thread: its plan waits, the lead's next turn fails, and no CLI is left to take over
    const other = await fleet.startThread({ title: "Other", task: "t", cwd: "/repo" });
    fleet.submitPlan(other.id, PLAN);
    report(other, { state: "blocked", summary: "The plan waits.", evidence: [], human_action: "Answer the plan." });
    await turn(other, "idle");
    await turn(other, "working");
    await fleet.send(other.id, "go on");
    runtime.output = "API Error: 529 overloaded";
    runtime.startImpl = async () => { throw new FleetError("agent_start_failed", "down"); };
    await turn(other, "idle");
    expect(registry.get(other.id)).toMatchObject({ state: "failed" });
    expect(registry.get(other.id)!.plan!.closedAt).toBeUndefined();
  });

  it("tells the coordinator of a project run without the person nothing of a restart, and the replacement's turn as usual", async () => {
    const { fleet, registry, turn, report, promptsTo } = thread({ config: { autonomous: true } });
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const first = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    await turn(first, "idle");
    const next = registry.get(registry.get(first.id)!.replacedBy!)!;
    expect(registry.get(first.id)!.notice).toBeUndefined();
    await turn(coordinator, "idle");
    expect(promptsTo(coordinator)).toEqual(["go"]);
    expect(next.owner).toBe(coordinator.id);
    expect(next.avoid).toEqual(["claude"]);
    report(next, { state: "ready", summary: "Fixed.", evidence: ["bun test: 3 pass"] });
    await turn(next, "idle");
    // a report: the CLIs that failed before get another chance at the next restart
    expect(registry.get(next.id)!.avoid).toBeUndefined();
    await turn(coordinator, "idle");
    expect(promptsTo(coordinator)[1]).toContain(`"Fix" (${next.id}, fleet/${first.id}) ended its turn: ready — Fixed.`);
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

  it("open a task sent from a pane's conversation with that pane, for the coordinator and the Fleet screen", async () => {
    const { fleet, runtime } = setup({ agents: [coordinator], gitRoot: async () => "/repo" });
    await fleet.startProject({ task: "Fix the doubled login error.", cwd: "/repo", fromPane: "w2:p3" });
    await fleet.startProject({ task: "And the logout one.", cwd: "/repo", fromPane: "w2:p3" });
    expect(runtime.prompts.map((p) => p.text)).toEqual(["[from pane w2:p3]\n\nFix the doubled login error.", "[from pane w2:p3]\n\nAnd the logout one."]);
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
    const report = (run: AgentRun, value: Record<string, unknown>) => writeFileSync(join(harness.root, "results", run.id, "report.json"), JSON.stringify(value));
    /** the lead's turn ends on a question for the person: a blocked report, and its HANDOFF */
    const ask = (run: AgentRun, question: string, text = `## HANDOFF\n${question}`) => {
      report(run, { state: "blocked", summary: question, evidence: [], human_action: question });
      handoff(run, text);
    };
    return { ...harness, states, turn, toCoordinator, handoff, report, ask };
  }

  const asks = (run: AgentRun, question: string, handoff = `## HANDOFF\n${question}`) => `- "${run.name}" (${run.id}, fleet/${run.id}) asks the person: ${question}\n${handoff.split("\n").map((line) => `  ${line}`).join("\n")}`;
  const HEADER = "[fleet] Threads ask the person. These come from the fleet, not from the person.";

  it("reach the coordinator once it is free, with the report's question and the whole HANDOFF", async () => {
    const { fleet, registry, turn, toCoordinator, ask } = project();
    const coordinator = await fleet.startProject({ task: "fix the retry", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const text = "## HANDOFF\nKeep the old retry API?\nOptions: A keep it (recommended), B drop it\nArchitect: callers in two packages use it";
    ask(thread, "Keep the old retry API?", text);
    await turn(thread, "idle");
    expect(toCoordinator(coordinator)).toEqual(["fix the retry", [HEADER, asks(thread, "Keep the old retry API?", text)].join("\n")]);
    expect(registry.get(thread.id)!.notice).toBeUndefined();
  });

  it("are only questions: a ready or failed report, no report, a failure and a wait on the screen go to the thread list and push notifications", async () => {
    const { fleet, registry, turn, toCoordinator, handoff, report, states } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const done = await fleet.startThread({ title: "Done", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const issues = await fleet.startThread({ title: "Issues", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const silent = await fleet.startThread({ title: "Silent", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const screen = await fleet.startThread({ title: "Screen", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const ended = await fleet.startThread({ title: "Ended", task: "t", cwd: "/repo", callerRun: coordinator.id });
    // a HANDOFF that reads like a question is prose: only the report says the person is asked
    handoff(done, "BLOCKED — or is it?");
    report(done, { state: "ready", summary: "bun test: 12 pass", evidence: [] });
    report(issues, { state: "failed", summary: "2 tests fail", evidence: [] });
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
    const { fleet, registry, turn, toCoordinator, ask } = project();
    const coordinator = await fleet.startProject({ task: "two things", cwd: "/repo" });
    const first = await fleet.startThread({ title: "One", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const second = await fleet.startThread({ title: "Two", task: "t", cwd: "/repo", callerRun: coordinator.id });
    ask(first, "Which log format?");
    ask(second, "May the old flag go?");
    await turn(first, "idle");
    await turn(second, "idle");
    // the fleet's own turn is still running
    expect(toCoordinator(coordinator)).toEqual(["two things"]);
    expect(registry.get(first.id)!.notice).toContain("Which log format?");
    await turn(coordinator, "idle");
    expect(toCoordinator(coordinator)[1]).toBe([HEADER, asks(first, "Which log format?"), asks(second, "May the old flag go?")].join("\n"));
    await turn(coordinator, "idle");
    // the person typed in its pane: herdr says working, with no turn of the fleet's
    await turn(coordinator, "working");
    await fleet.send(first.id, "JSON");
    ask(first, "One file or one per day?");
    await turn(first, "idle");
    expect(toCoordinator(coordinator)).toHaveLength(2);
    await turn(coordinator, "idle");
    expect(toCoordinator(coordinator)).toEqual([expect.anything(), expect.anything(), [HEADER, asks(first, "One file or one per day?")].join("\n")]);
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
    writeFileSync(join(root, "results", thread.id, "report.json"), JSON.stringify({ state: "blocked", summary: "Which one?", evidence: [], human_action: "Which one?" }));
    states.set(thread.herdrName, "idle");
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(thread.paneId);
    await Bun.sleep(80);
    const toCoordinator = () => runtime.prompts.filter((p) => p.name === coordinator.herdrName).map((p) => p.text);
    expect(toCoordinator()).toEqual(["go"]);
    runtime.screens.set(coordinator.herdrName, "❯\u00a0\x1b[2mTry \"fix lint errors\"\x1b[0m");
    await Bun.sleep(80);
    expect(toCoordinator()).toHaveLength(2);
    expect(toCoordinator()[1]).toContain("asks the person: Which one?");
    fleet.stop();
  });

  it("carry a long HANDOFF cut, the rest left in the result file", async () => {
    const { fleet, registry, turn, ask } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    ask(thread, "Which one?", `Which one?\n${"x".repeat(5000)}`);
    await turn(thread, "idle");
    const notice = registry.get(thread.id)!.notice!;
    expect(notice).toEndWith("[cut at 4000 characters]");
    expect(notice.length).toBeLessThan(4200);
  });

  it("are kept while no coordinator lives, for the project's next one", async () => {
    const { fleet, registry, turn, toCoordinator, ask } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    fleet.onPaneEnded(coordinator.paneId);
    ask(thread, "Which one?");
    await turn(thread, "idle");
    expect(registry.get(thread.id)!.notice).toContain("Which one?");
    const next = await fleet.startProject({ task: "and now?", cwd: "/repo" });
    expect(toCoordinator(next)).toEqual(["and now?"]);
    await turn(next, "idle");
    expect(toCoordinator(next)[1]).toBe([HEADER, asks(thread, "Which one?")].join("\n"));
    expect(registry.get(thread.id)!.notice).toBeUndefined();
  });

  it("are kept across a restart", async () => {
    const { fleet, registry, turn, root, ask } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    ask(thread, "Which one?");
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

describe("a project run without the person", () => {
  const agents = [role("coordinator", { interactive: true, spawning: true }), role("lead", { interactive: true, spawning: true }), role("reviewer", { agent: "agy" })];
  const NEWS = "[fleet] Threads ended a turn. These come from the fleet, not from the person.";
  const QUIET = 120;
  const ANDON = "[fleet] Nothing in this project has moved";

  function project(config: Partial<FleetConfig> = {}) {
    const states = new Map<string, AgentState>();
    const removed: string[] = [];
    const events: FleetEvent[] = [];
    const git = { pr: null as Record<string, unknown> | null, reads: 0 };
    const harness = setup({
      agents, gitRoot: async () => "/repo", config: { autonomous: true, ...config }, quietMs: QUIET, events: (event) => events.push(event),
      landing: {
        gitBranch: async () => "rust",
        readPullRequest: async () => { git.reads += 1; return git.pr as never; },
        branchHead: async () => "c0ffee",
        removeThread: async (_repo, _worktree, branch) => { removed.push(branch); return undefined; },
      },
    });
    harness.runtime.getImpl = async (name) => states.get(name) ?? "working";
    const turn = async (run: AgentRun, state: AgentState) => {
      states.set(run.herdrName, state);
      await Bun.sleep(GRACE + 5);
      harness.fleet.onPaneStatus(run.paneId);
      await Bun.sleep(30);
    };
    const toCoordinator = (coordinator: AgentRun) => harness.runtime.prompts.filter((p) => p.name === coordinator.herdrName).map((p) => p.text);
    const handoff = (run: AgentRun, text: string, contract?: string) => {
      writeFileSync(join(harness.root, "results", run.id, "handoff.md"), text);
      if (contract) writeFileSync(join(harness.root, "results", run.id, "contract.md"), contract);
    };
    const report = (run: AgentRun, value: Record<string, unknown>) => writeFileSync(join(harness.root, "results", run.id, "report.json"), JSON.stringify(value));
    return { ...harness, states, turn, toCoordinator, handoff, report, git, removed, events };
  }

  it("tells the coordinator every turn a thread ends, with its report and contract, not only its questions", async () => {
    const { fleet, registry, turn, toCoordinator, handoff, report } = project();
    // the coordinator's own turn is still running while both threads end
    const coordinator = await fleet.startProject({ task: "port the parser", cwd: "/repo" });
    const done = await fleet.startThread({ title: "Done", task: "t", cwd: "/repo", callerRun: coordinator.id });
    const issues = await fleet.startThread({ title: "Issues", task: "t", cwd: "/repo", callerRun: coordinator.id });
    handoff(done, "## HANDOFF\nOutcome: parses", "- [x] A1 parses — evidence: test\n- [!] A2 fast — evidence: none");
    report(done, { state: "ready", summary: "cargo test: 40 pass", evidence: ["cargo test"] });
    report(issues, { state: "failed", summary: "2 cases fail", evidence: ["cargo test"] });
    await turn(done, "idle");
    await turn(issues, "idle");
    await turn(coordinator, "idle");
    expect(toCoordinator(coordinator)[1]).toBe([
      NEWS,
      `- "${done.name}" (${done.id}, fleet/${done.id}) ended its turn: ready — cargo test: 40 pass\n  Contract: A1 ✓ A2 ✗`,
      `- "${issues.name}" (${issues.id}, fleet/${issues.id}) ended its turn: failed — 2 cases fail`,
    ].join("\n"));
    for (const run of [done, issues]) expect(registry.get(run.id)!.notice).toBeUndefined();
  });

  it("closes a thread whose lead merged its own pull request as the lead's turn ends, and says so", async () => {
    const { fleet, registry, turn, toCoordinator, report, git, removed } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Port", task: "t", cwd: "/repo", callerRun: coordinator.id });
    git.pr = { number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED", checks: "pass", head: "c0ffee" };
    report(thread, { state: "ready", summary: "Merged #7 into rust.", evidence: [] });
    await turn(thread, "idle");
    expect(registry.get(thread.id)!.landed).toBe("merged");
    expect(removed).toEqual([thread.branch!]);
    await turn(coordinator, "idle");
    expect(toCoordinator(coordinator)[1]).toBe([NEWS, `- "${thread.name}" (${thread.id}, fleet/${thread.id}) ended its turn: ready — Merged #7 into rust.\n  Pull request #7: MERGED, and the thread is closed`].join("\n"));
  });

  it("tells the coordinator of a turn the thread's agent started itself, as its helpers' results woke it", async () => {
    const { fleet, registry, turn, toCoordinator, handoff, report, git, removed } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Split", task: "t", cwd: "/repo", callerRun: coordinator.id });
    // the lead's turn breaks off while it waits for its helpers: it reports waiting
    report(thread, { state: "waiting", summary: "Waiting for the helpers.", evidence: [] });
    await turn(thread, "idle");
    expect(toCoordinator(coordinator)[1]).toBe([NEWS, `- "${thread.name}" (${thread.id}, fleet/${thread.id}) ended its turn: waiting — Waiting for the helpers.`].join("\n"));
    await turn(coordinator, "idle");
    // the helpers' results start the next turn: the fleet sent nothing
    await turn(thread, "working");
    git.pr = { number: 9, url: "https://github.com/o/r/pull/9", state: "MERGED", checks: "pass", head: "c0ffee" };
    handoff(thread, "## HANDOFF\nOutcome: split", "- [x] A1 split — evidence: #9");
    report(thread, { state: "ready", summary: "Merged #9 into rust.", evidence: [] });
    await turn(thread, "idle");
    expect(registry.get(thread.id)!).toMatchObject({ landed: "merged", contract: [{ id: "A1", state: "met" }] });
    expect(removed).toEqual([thread.branch!]);
    expect(toCoordinator(coordinator)[2]).toBe([NEWS, `- "${thread.name}" (${thread.id}, fleet/${thread.id}) ended its turn: ready — Merged #9 into rust.\n  Contract: A1 ✓\n  Pull request #9: MERGED, and the thread is closed`].join("\n"));
  });

  it("does not tell the coordinator again while a thread stays settled", async () => {
    const { fleet, turn, toCoordinator, report } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Port", task: "t", cwd: "/repo", callerRun: coordinator.id });
    report(thread, { state: "failed", summary: "1 case fails", evidence: [] });
    await turn(thread, "idle");
    await turn(coordinator, "idle");
    await turn(thread, "idle");
    await fleet.reconcileAll();
    await Bun.sleep(30);
    expect(toCoordinator(coordinator)).toHaveLength(2);
  });

  it("tells the coordinator once when it and every thread stayed settled through the quiet period, and again only after a thread moved", async () => {
    const { fleet, turn, toCoordinator, handoff } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Port", task: "t", cwd: "/repo", callerRun: coordinator.id });
    handoff(thread, "ISSUES — 1 case fails");
    await turn(thread, "idle");
    await turn(coordinator, "idle");
    const told = toCoordinator(coordinator).length;
    await fleet.superviseProjects();
    // not before the quiet period is over
    await fleet.superviseProjects();
    expect(toCoordinator(coordinator)).toHaveLength(told);
    await Bun.sleep(QUIET + 20);
    await fleet.superviseProjects();
    const andon = toCoordinator(coordinator)[told]!;
    expect(andon).toStartWith(`${ANDON} for 0 minutes: you and every thread are settled. This comes from the fleet, not from the person.`);
    expect(andon).toContain(`- "${thread.name}" (${thread.id}, fleet/${thread.id}): idle`);
    // the coordinator answers and does nothing: no second call for the same quiet period
    await turn(coordinator, "idle");
    await Bun.sleep(QUIET + 20);
    await fleet.superviseProjects();
    expect(toCoordinator(coordinator)).toHaveLength(told + 1);
    // a thread moves, then settles: the next quiet period calls again
    await turn(thread, "working");
    await fleet.superviseProjects();
    await turn(thread, "idle");
    await turn(coordinator, "idle");
    const before = toCoordinator(coordinator).length;
    await fleet.superviseProjects();
    await Bun.sleep(QUIET + 20);
    await fleet.superviseProjects();
    expect(toCoordinator(coordinator)).toHaveLength(before + 1);
    expect(toCoordinator(coordinator).at(-1)).toStartWith(ANDON);
  });

  it("records each change of a run's state once, whether the fleet sent the turn, the person's messages, a standstill and a thread closed against GitHub", async () => {
    const { fleet, turn, handoff, git, events } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    await fleet.startProject({ task: "and this too", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Port", task: "t", cwd: "/repo", callerRun: coordinator.id });
    handoff(thread, "ISSUES");
    await turn(thread, "idle");
    await turn(coordinator, "idle");
    // a turn the fleet did not send: the lead's own
    await turn(thread, "working");
    await turn(thread, "idle");
    await turn(coordinator, "idle");
    const states = (id: string) => events.filter((e) => e.kind === "state" && e.run === id).map((e) => e.kind === "state" && `${e.from ?? "-"}>${e.to}${e.sent ? " sent" : ""}`);
    // ready, the task sent, that turn ended; then a turn of its own, which the fleet did not send
    expect(states(thread.id)).toEqual(["->starting", "starting>idle", "idle>working sent", "working>idle sent", "idle>working", "working>idle"]);
    expect(events.filter((e) => e.kind === "person")).toEqual([{ kind: "person", run: coordinator.id, project: "/repo" }]);
    expect(events.find((e) => e.kind === "state" && e.run === thread.id)).toMatchObject({ role: "lead", agent: "pi", project: "/repo", group: thread.group });
    git.pr = { number: 12, url: "https://github.com/o/r/pull/12", state: "MERGED", checks: "pass", head: "c0ffee" };
    await fleet.superviseProjects();
    await Bun.sleep(QUIET + 20);
    await fleet.superviseProjects();
    expect(events.filter((e) => e.kind === "reconciled")).toEqual([{ kind: "reconciled", run: thread.id, project: "/repo", pr: 12 }]);
    await turn(coordinator, "idle");
    await fleet.superviseProjects();
    await Bun.sleep(QUIET + 20);
    await fleet.superviseProjects();
    expect(events.filter((e) => e.kind === "standstill")).toMatchObject([{ kind: "standstill", run: coordinator.id, project: "/repo" }]);
  });

  it("no longer tells the coordinator of an agent whose runs end without a report, as #184 did", async () => {
    const { fleet, runtime, turn, toCoordinator, handoff, report, events } = project();
    runtime.output = ">\n? for shortcuts    auto · Gemini 4 Argon · medium";
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Port", task: "t", cwd: "/repo", callerRun: coordinator.id });
    report(thread, { state: "waiting", summary: "Waiting for the review.", evidence: [] });
    await turn(thread, "idle");
    await turn(coordinator, "idle");
    // two reviews on agy whose panes closed before they wrote anything, and one that did its work
    const lost = [];
    for (let i = 0; i < 3; i++) lost.push(await fleet.spawn({ role: "reviewer", task: "review", group: thread.group, cwd: "/repo" }));
    handoff(lost[2]!, "no findings");
    report(lost[2]!, { state: "ready", summary: "No findings.", evidence: [] });
    await turn(lost[2]!, "idle");
    fleet.onPaneEnded(lost[0]!.paneId);
    fleet.onPaneEnded(lost[1]!.paneId);
    await turn(coordinator, "idle");
    const told = toCoordinator(coordinator).length;
    await fleet.superviseProjects();
    expect(toCoordinator(coordinator).slice(told)).toEqual([]);
    expect(events.filter((e) => (e.kind as string) === "anomaly")).toEqual([]);
  });

  it("records each turn's end with the report read, and keeps the pane of a helper whose turn settled without one", async () => {
    const { fleet, runtime, turn, report, events } = project({ closeOnSettle: false });
    runtime.output = ">\n? for shortcuts    auto · Gemini 4 Argon · medium";
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Port", task: "t", cwd: "/repo", callerRun: coordinator.id });
    report(thread, { state: "waiting", summary: "Waiting for the review.", evidence: [] });
    await turn(thread, "idle");
    const reviews = [];
    for (let i = 0; i < 2; i++) reviews.push(await fleet.spawn({ role: "reviewer", task: "review", group: thread.group, cwd: "/repo" }));
    report(reviews[0]!, { state: "ready", summary: "No findings.", evidence: [] });
    for (const review of reviews) await turn(review, "idle");
    expect(events.filter((e) => e.kind === "turn" && e.role === "reviewer").map((e) => e.kind === "turn" && [e.run, e.report, e.interactive]))
      .toEqual([[reviews[0]!.id, "ready", false], [reviews[1]!.id, "none", false]]);
    expect(fleet.get(reviews[1]!.id).state).toBe("idle");
  });

  it("leaves a project run with the person alone: no standstill call and no closing against GitHub", async () => {
    const removed: string[] = [];
    const { fleet, runtime, registry, root } = setup({
      agents, gitRoot: async () => "/repo", quietMs: QUIET,
      landing: { gitBranch: async () => "main", branchHead: async () => "c0ffee", removeThread: async (_r, _w, branch) => { removed.push(branch); return undefined; },
        readPullRequest: async () => ({ number: 3, url: "https://github.com/o/r/pull/3", state: "MERGED", checks: "pass", head: "c0ffee" }) as never },
    });
    runtime.getStatus = "idle";
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    const thread = await fleet.startThread({ title: "Port", task: "t", cwd: "/repo", callerRun: coordinator.id });
    writeFileSync(join(root, "results", thread.id, "handoff.md"), "PASS");
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(thread.paneId);
    fleet.onPaneStatus(coordinator.paneId);
    await Bun.sleep(30);
    const told = runtime.prompts.filter((p) => p.name === coordinator.herdrName).length;
    await fleet.superviseProjects();
    await Bun.sleep(QUIET + 20);
    await fleet.superviseProjects();
    expect(runtime.prompts.filter((p) => p.name === coordinator.herdrName)).toHaveLength(told);
    expect(registry.get(thread.id)!.landed).toBeUndefined();
    expect(removed).toEqual([]);
  });

  it("closes a thread GitHub shows merged once its lead stayed settled through the quiet period, and tells the coordinator", async () => {
    const { fleet, registry, turn, toCoordinator, handoff, git, removed } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Port", task: "t", cwd: "/repo", callerRun: coordinator.id });
    // its turn ended before the fleet saw a pull request; the merge came after, and no turn ended since
    handoff(thread, "ISSUES — waiting for the review");
    await turn(thread, "idle");
    await turn(coordinator, "idle");
    expect(registry.get(thread.id)!.pr).toBeUndefined();
    git.pr = { number: 11, url: "https://github.com/o/r/pull/11", state: "MERGED", checks: "pass", head: "c0ffee" };
    await fleet.superviseProjects();
    await fleet.superviseProjects();
    // a lead that settled just now may be between two turns of its own: not yet
    expect(registry.get(thread.id)!.landed).toBeUndefined();
    await Bun.sleep(QUIET + 20);
    await fleet.superviseProjects();
    expect(registry.get(thread.id)!).toMatchObject({ landed: "merged", pr: { number: 11, state: "MERGED" } });
    expect(removed).toEqual([thread.branch!]);
    await until(() => toCoordinator(coordinator).some((text) => text.includes("pull request #11")), "the coordinator hears of it");
    expect(toCoordinator(coordinator).at(-1)).toBe([NEWS, `- "${thread.name}" (${thread.id}, fleet/${thread.id}): GitHub shows pull request #11 merged and its lead stayed settled 0 minutes, so the fleet closed the thread. Close its issue if it is still open.`].join("\n"));
  });

  it("leaves a thread whose pull request the polling finds merged open for its lead to finish, tells the coordinator, and closes it as the lead's turn ends", async () => {
    const { fleet, registry, turn, toCoordinator, handoff, git, removed } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Port", task: "t", cwd: "/repo", callerRun: coordinator.id });
    git.pr = { number: 8, url: "https://github.com/o/r/pull/8", state: "OPEN", checks: "pending", head: "c0ffee" };
    handoff(thread, "PASS — opened #8");
    await turn(thread, "idle");
    await turn(coordinator, "idle");
    expect(registry.get(thread.id)!.pr).toMatchObject({ number: 8, state: "OPEN" });
    // the lead merged it in a turn that broke off to wait: it has the issue to close yet
    git.pr = { ...git.pr, state: "MERGED" };
    await fleet.refreshPullRequests();
    await Bun.sleep(30);
    expect(registry.get(thread.id)!).toMatchObject({ pr: { number: 8, state: "MERGED" } });
    expect(registry.get(thread.id)!.landed).toBeUndefined();
    expect(removed).toEqual([]);
    expect(toCoordinator(coordinator)[2]).toBe([NEWS, `- "${thread.name}" (${thread.id}, fleet/${thread.id}) merged pull request #8; the thread closes once its lead's turn ends`].join("\n"));
    // told once, however often the polling runs
    await turn(coordinator, "idle");
    await fleet.refreshPullRequests();
    await Bun.sleep(30);
    expect(toCoordinator(coordinator)).toHaveLength(3);
    // the lead's own next turn ends: the thread closes
    await turn(thread, "working");
    handoff(thread, "PASS — merged #8, closed the issue");
    await turn(thread, "idle");
    expect(registry.get(thread.id)!.landed).toBe("merged");
    expect(removed).toEqual([thread.branch!]);
  });
});

describe("landing", () => {
  const agents = [role("coordinator", { interactive: true, spawning: true }), role("lead", { interactive: true, spawning: true }), role("reviewer")];
  const PR = { number: 70, url: "https://github.com/o/r/pull/70", state: "OPEN", checks: "pending", head: "c0ffee" } as const;

  function project() {
    const states = new Map<string, AgentState>();
    const removed: Array<{ repo: string; worktree: string; branch: string; options: unknown }> = [];
    const git = { pr: null as typeof PR | null | { state: string; [key: string]: unknown }, prError: undefined as string | undefined, merged: false, behind: 0, head: "c0ffee" as string | null, kept: undefined as string | undefined };
    const harness = setup({
      agents, gitRoot: async () => "/repo",
      landing: {
        gitBranch: async () => "main",
        readPullRequest: async () => { if (git.prError) throw new Error(git.prError); return git.pr as never; },
        isMerged: async () => git.merged,
        branchState: async () => ({ uncommitted: [], ahead: 2, behind: git.behind }),
        branchHead: async () => git.head,
        diffText: async () => ({ diff: "diff --git a/x b/x", truncated: false }),
        removeThread: async (repo, worktree, branch, options) => { removed.push({ repo, worktree, branch, options }); return git.kept; },
      },
    });
    harness.runtime.getImpl = async (name) => states.get(name) ?? "working";
    const turn = async (run: AgentRun, state: AgentState) => {
      states.set(run.herdrName, state);
      await Bun.sleep(GRACE + 5);
      harness.fleet.onPaneStatus(run.paneId);
      await Bun.sleep(30);
    };
    const to = (run: AgentRun) => harness.runtime.prompts.filter((p) => p.name === run.herdrName).map((p) => p.text);
    /** a coordinator, and a thread of its that ended a turn reporting ready */
    const ready = async () => {
      const coordinator = await harness.fleet.startProject({ task: "fix the retry", cwd: "/repo" });
      await turn(coordinator, "idle");
      const thread = await harness.fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
      writeReport(harness.root, thread.id, "ready", "bun test: 12 pass");
      await turn(thread, "idle");
      return { coordinator, thread };
    };
    return { ...harness, states, turn, to, ready, git, removed };
  }

  it("start a thread on the branch the main checkout is on, and measure its change from there", async () => {
    const bases: string[] = [];
    const { fleet, runtime, registry } = setup({ agents, gitRoot: async () => "/repo", gitHead: async () => "abc1234", landing: { gitBranch: async () => "main" },
      diffStat: async (_cwd, base) => { bases.push(base); return { added: 1, removed: 0, files: 1 }; } });
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo" });
    expect(thread).toMatchObject({ base: "abc1234", baseBranch: "main" });
    runtime.getStatus = "idle";
    await Bun.sleep(GRACE + 5);
    fleet.onPaneStatus(thread.paneId);
    await Bun.sleep(30);
    expect(bases).toEqual(["main"]);
    expect(registry.get(thread.id)!.diff).toEqual({ added: 1, removed: 0, files: 1 });
  });

  it("hand Create PR to the lead as the person's approval to push and open it, and keep the pull request it opened", async () => {
    const { fleet, registry, root, turn, to, ready, git } = project();
    const { thread } = await ready();
    await fleet.land(thread.id, "pr");
    const message = to(thread).at(-1)!;
    expect(message).toStartWith("[fleet] The person pressed Create PR on the Fleet screen: they approve pushing fleet/");
    expect(message).toContain(`pushing ${thread.branch} to origin and opening a pull request from it against main`);
    expect(message).toContain("never force");
    expect(message).toContain("Do not merge it.");
    expect(registry.get(thread.id)!.landing).toMatchObject({ action: "pr", sent: true });
    // a second step waits for the lead's turn to end
    await expect(fleet.land(thread.id, "update")).rejects.toMatchObject({ code: "landing_busy" });
    git.pr = PR;
    writeReport(root, thread.id, "ready", "Opened #70.");
    await turn(thread, "idle");
    const landed = registry.get(thread.id)!;
    expect(landed.pr).toEqual({ number: 70, url: PR.url, state: "OPEN", checks: "pending" });
    expect(landed.landing).toBeUndefined();
    expect(threadState(landed)).toBe("landing");
  });

  it("say on the thread when the step did not happen, and let the person press it again", async () => {
    const { fleet, registry, turn, ready, git } = project();
    const { thread } = await ready();
    await fleet.land(thread.id, "pr");
    await turn(thread, "idle");
    expect(registry.get(thread.id)!.landing).toMatchObject({ action: "pr", error: `The lead's turn ended without an open pull request for ${thread.branch}.` });
    expect(threadState(registry.get(thread.id)!)).toBe("waiting");
    git.behind = 3;
    await fleet.land(thread.id, "update");
    await turn(thread, "idle");
    expect(registry.get(thread.id)!.landing?.error).toBe(`${thread.branch} is still 3 commits behind main.`);
  });

  it("send the person's comments together, and Fix CI with the failing checks, each asking to push to the open pull request", async () => {
    const { fleet, registry, turn, to, ready, git } = project();
    const { thread } = await ready();
    await fleet.land(thread.id, "comments", { comments: [{ file: "src/retry.ts", line: 12, text: "Keep the\nold name." }, { file: "README.md", line: 3, removed: true, text: "Typo" }] });
    expect(to(thread).at(-1)).toBe([
      "[fleet] The person reviewed this thread's change on the Fleet screen and left these comments:",
      "- src/retry.ts:12 — Keep the old name.",
      "- README.md:3 (a removed line) — Typo",
      "Address each one and commit. Where you disagree, say why in your HANDOFF instead of changing the code.",
    ].join("\n"));
    await turn(thread, "idle");
    expect(registry.get(thread.id)!.landing).toBeUndefined();
    await expect(fleet.land(thread.id, "fix-ci")).rejects.toMatchObject({ code: "no_pull_request" });
    await expect(fleet.land(thread.id, "comments", { comments: [] })).rejects.toMatchObject({ code: "missing_comments" });
    registry.upsert({ ...registry.get(thread.id)!, pr: { number: 70, url: PR.url, state: "OPEN", checks: "fail", failing: ["test", "lint"] } });
    git.pr = { ...PR, checks: "fail", failing: ["test", "lint"] };
    expect(threadState(registry.get(thread.id)!)).toBe("waiting");
    await fleet.land(thread.id, "fix-ci");
    expect(to(thread).at(-1)).toBe(`[fleet] The person pressed Fix CI on the Fleet screen: checks failed on pull request #70 (test, lint). Read their logs (gh pr checks 70, gh run view --log-failed), fix the cause, commit, and push ${thread.branch} to its pull request #70.`);
    // the lead is at work: nothing more goes to it until its turn ends
    await expect(fleet.land(thread.id, "comments", { comments: [{ file: "a", line: 1, text: "b" }] })).rejects.toMatchObject({ code: "landing_busy" });
  });

  it("hand Merge into main to the coordinator once it is free, then close the merged thread: its panes, worktree and branch", async () => {
    const { fleet, registry, runtime, turn, to, ready, git, removed } = project();
    const { coordinator, thread } = await ready();
    const helper = await fleet.spawn({ role: "reviewer", task: "review", group: thread.group, cwd: "/repo" });
    // the person talks with the coordinator: the merge waits for its turn to end
    await turn(coordinator, "working");
    await fleet.land(thread.id, "merge");
    expect(registry.get(thread.id)!.landing).toMatchObject({ action: "merge", sent: false });
    expect(to(coordinator)).toEqual(["fix the retry"]);
    await turn(coordinator, "idle");
    expect(to(coordinator).at(-1)).toBe([
      "[fleet] The person pressed these on the Fleet screen. Each is the person's approval for that step only.",
      `- Merge into main for thread "Fix" (${thread.id}, ${thread.branch}): when this checkout is clean and on main, git merge --no-ff ${thread.branch}. On a conflict, git merge --abort and tell the person.`,
    ].join("\n"));
    expect(registry.get(thread.id)!.landing).toMatchObject({ action: "merge", sent: true });
    git.merged = true;
    await turn(coordinator, "idle");
    expect(runtime.closed).toEqual(expect.arrayContaining([thread.paneId, helper.paneId]));
    expect(removed).toEqual([{ repo: "/repo", worktree: `/repo/.herdr-fleet/worktrees/${thread.id}`, branch: thread.branch!, options: { force: false, branchMerged: false } }]);
    const closed = registry.get(thread.id)!;
    expect(closed).toMatchObject({ landed: "merged", state: "stopped" });
    expect(closed.landing).toBeUndefined();
    expect(threadState(closed)).toBe("resolved");
    expect(registry.get(helper.id)!.state).toBe("stopped");
    await expect(fleet.land(thread.id, "merge")).rejects.toMatchObject({ code: "thread_landed" });
  });

  it("say what git kept, and that a merge did not happen", async () => {
    const { fleet, registry, turn, ready, git } = project();
    const { coordinator, thread } = await ready();
    await fleet.land(thread.id, "merge");
    await turn(coordinator, "idle");
    expect(registry.get(thread.id)!.landing?.error).toBe(`${thread.branch} is not in main after the coordinator's turn; its reply says why.`);
    expect(registry.get(thread.id)!.landed).toBeUndefined();
    git.merged = true;
    git.kept = "The worktree /repo/.herdr-fleet/worktrees/x was kept: contains modified or untracked files";
    await fleet.land(thread.id, "merge");
    await turn(coordinator, "idle");
    expect(registry.get(thread.id)!).toMatchObject({ landed: "merged", landing: { error: git.kept } });
  });

  it("start a coordinator for a merge when none lives", async () => {
    const { fleet, registry, runtime, ready, to } = project();
    const { coordinator, thread } = await ready();
    registry.upsert({ ...registry.get(coordinator.id)!, state: "stopped" });
    await fleet.land(thread.id, "merge");
    const started = registry.all().find((run) => run.role === "coordinator" && run.id !== coordinator.id)!;
    expect(to(started)[0]).toContain(`Merge into main for thread "Fix"`);
    expect(registry.get(thread.id)!.landing).toMatchObject({ sent: true });
    expect(runtime.locations.at(-1)).toMatchObject({ cwd: "/repo" });
  });

  it("hand Merge PR to the coordinator, and delete the branch once GitHub merged the commit it is at here", async () => {
    const { fleet, registry, turn, to, ready, git, removed } = project();
    const { coordinator, thread } = await ready();
    await expect(fleet.land(thread.id, "merge-pr")).rejects.toMatchObject({ code: "no_pull_request" });
    registry.upsert({ ...registry.get(thread.id)!, pr: { number: 70, url: PR.url, state: "OPEN", checks: "pass" } });
    await fleet.land(thread.id, "merge-pr");
    expect(to(coordinator).at(-1)).toContain("Merge PR for thread \"Fix\"");
    expect(to(coordinator).at(-1)).toContain("gh pr merge 70 --merge");
    git.pr = { ...PR, state: "MERGED", checks: "none" };
    await turn(coordinator, "idle");
    expect(removed.at(-1)!.options).toEqual({ force: false, branchMerged: true });
    expect(registry.get(thread.id)!).toMatchObject({ landed: "merged", pr: { state: "MERGED" } });
  });

  it("throw a thread away at once: its panes, worktree and branch whatever they hold", async () => {
    const { fleet, registry, runtime, ready, removed } = project();
    const { thread } = await ready();
    await fleet.land(thread.id, "discard");
    expect(runtime.closed).toContain(thread.paneId);
    expect(removed).toEqual([{ repo: "/repo", worktree: `/repo/.herdr-fleet/worktrees/${thread.id}`, branch: thread.branch!, options: { force: true, branchMerged: false } }]);
    expect(registry.get(thread.id)!).toMatchObject({ landed: "discarded", state: "stopped" });
    expect(threadState(registry.get(thread.id)!)).toBe("resolved");
  });

  it("read the open pull requests again, and close a thread the person merged on GitHub", async () => {
    const { fleet, registry, ready, git, removed } = project();
    const { thread } = await ready();
    registry.upsert({ ...registry.get(thread.id)!, pr: { number: 70, url: PR.url, state: "OPEN", checks: "pending" } });
    git.pr = { ...PR, checks: "pass" };
    await fleet.refreshPullRequests();
    expect(registry.get(thread.id)!.pr?.checks).toBe("pass");
    git.pr = { ...PR, state: "MERGED", head: "older" };
    await fleet.refreshPullRequests();
    // GitHub merged another commit than the branch is at here: the branch stays
    expect(removed.at(-1)!.options).toEqual({ force: false, branchMerged: false });
    expect(registry.get(thread.id)!.landed).toBe("merged");
  });

  it("answer the checks: the worktree, the branch beside its base, and the pull request, or why GitHub could not say", async () => {
    const { fleet, registry, ready, git } = project();
    const { thread } = await ready();
    git.behind = 2;
    git.pr = PR;
    expect(await fleet.checks(thread.id)).toEqual({ baseBranch: "main", uncommitted: [], ahead: 2, behind: 2, pr: { number: 70, url: PR.url, state: "OPEN", checks: "pending" } });
    expect(registry.get(thread.id)!.pr?.number).toBe(70);
    git.prError = "gh: To get started with GitHub CLI, please run: gh auth login";
    expect(await fleet.checks(thread.id)).toMatchObject({ prError: git.prError, pr: { number: 70 } });
    expect(await fleet.diff(thread.id)).toEqual({ diff: "diff --git a/x b/x", truncated: false });
    const helper = await spawn(fleet, { role: "reviewer" });
    await expect(fleet.checks(helper.id, helper.group)).rejects.toMatchObject({ code: "not_a_thread" });
  });
});

describe("plans", () => {
  const agents = [role("coordinator", { interactive: true, spawning: true }), role("lead", { interactive: true, spawning: true }), role("reviewer")];
  const PLAN = {
    title: "Retry limit",
    claims: [{ text: "A failed send is tried three times.", exhibit: { kind: "code", path: "src/retry.ts", start: 1 },
      ask: { id: "limit", question: "How many?", options: [{ value: "three", label: "3" }, { value: "five", label: "5" }], recommended: "three" } }],
  };

  function project() {
    const states = new Map<string, AgentState>();
    // the thread's worktree is a real folder: the plan's code is read from it
    const tree = mkdtempSync(join(tmpdir(), "fleet-plan-tree-"));
    roots.push(tree);
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, "src", "retry.ts"), "export const RETRIES = 3;\n");
    const harness = setup({ agents, gitRoot: async () => "/repo" });
    harness.runtime.createLocationImpl = async (options) => ({ paneId: `w1:p${harness.runtime.locations.length}`, cwd: options.worktree ? tree : options.cwd });
    harness.runtime.getImpl = async (name) => states.get(name) ?? "working";
    const turn = async (run: AgentRun, state: AgentState) => {
      states.set(run.herdrName, state);
      await Bun.sleep(GRACE + 5);
      harness.fleet.onPaneStatus(run.paneId);
      await Bun.sleep(30);
    };
    const to = (run: AgentRun) => harness.runtime.prompts.filter((p) => p.name === run.herdrName).map((p) => p.text);
    /** a coordinator, and a thread whose lead handed over a plan and ended its turn blocked */
    const planned = async () => {
      const coordinator = await harness.fleet.startProject({ task: "fix the retry", cwd: "/repo" });
      await turn(coordinator, "idle");
      const thread = await harness.fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
      const plan = harness.fleet.submitPlan(thread.id, PLAN);
      writeReport(harness.root, thread.id, "blocked", "The plan waits for the person.", "Answer the plan in the Plan tab.");
      await turn(thread, "idle");
      return { coordinator, thread, plan };
    };
    return { ...harness, states, turn, to, planned, tree };
  }

  it("are kept beside the lead's result file with the code read from its worktree, and the thread waits on the person", async () => {
    const { fleet, registry, root, planned } = project();
    const { thread, plan } = await planned();
    expect(plan.version).toBe(1);
    expect(plan.claims[0]!.exhibit).toMatchObject({ lines: ["export const RETRIES = 3;"] });
    expect(JSON.parse(readFileSync(join(root, "fleet-plans", `${thread.id}.json`), "utf8"))).toEqual(plan);
    expect(fleet.plan(thread.id)).toEqual(plan);
    expect(registry.get(thread.id)!.plan).toEqual({ version: 1, asks: 1 });
    expect(threadState(registry.get(thread.id)!)).toBe("waiting");
    expect(fleet.submitPlan(thread.id, PLAN).version).toBe(2);
    fleet.stop();
  });

  it("send the coordinator to the Plan tab rather than have it answer", async () => {
    const { fleet, to, planned } = project();
    const { coordinator } = await planned();
    expect(to(coordinator)[1]).toContain("waits for the person in the thread's Plan tab on the Fleet screen: point them there, and do not answer it yourself.");
    fleet.stop();
  });

  it("reach the lead as its next task once answered, and only once", async () => {
    const { fleet, registry, to, root, planned } = project();
    const { thread } = await planned();
    await fleet.answerPlan(thread.id, { version: 1, choices: { limit: "five" }, seen: ["limit"], comments: [] });
    expect(to(thread).at(-1)).toContain("- D1 (on claim 1) How many? → 5 [limit=five] (instead of your recommendation, 3)");
    expect(registry.get(thread.id)!.plan!.answeredAt).toBeNumber();
    expect(JSON.parse(readFileSync(join(root, "fleet-plans", `${thread.id}.json`), "utf8"))).toMatchObject({ answeredAt: expect.any(Number), answer: { version: 1, choices: { limit: "five" }, seen: ["limit"] } });
    expect(threadState(registry.get(thread.id)!)).toBe("working");
    await expect(fleet.answerPlan(thread.id, { version: 1 })).rejects.toMatchObject({ code: "plan_answered" });
    fleet.stop();
  });

  it("wait for the lead's turn to end, and refuse an answer to an older version", async () => {
    const { fleet, runtime, planned, turn } = project();
    const { thread } = await planned();
    fleet.submitPlan(thread.id, PLAN);
    await expect(fleet.answerPlan(thread.id, { version: 1 })).rejects.toMatchObject({ code: "plan_outdated" });
    await fleet.send(thread.id, "one more thing");
    await expect(fleet.answerPlan(thread.id, { version: 2 })).rejects.toMatchObject({ code: "run_busy" });
    // in that turn the lead writes version 3, which then waits for the person
    fleet.submitPlan(thread.id, PLAN);
    await turn(thread, "idle");
    const prompts = runtime.prompts.length;
    await fleet.answerPlan(thread.id, { version: 3 });
    expect(runtime.prompts.length).toBe(prompts + 1);
    fleet.stop();
  });

  it("hold the thread waiting only through the blocked turn: a lead that did not stop is ready for review", async () => {
    const { fleet, registry, root, turn } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    await turn(coordinator, "idle");
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    fleet.submitPlan(thread.id, PLAN);
    writeReport(root, thread.id, "ready", "Built without waiting.");
    await turn(thread, "idle");
    expect(threadState(registry.get(thread.id)!)).toBe("review");
    // the plan was written in that turn: it still takes answers
    expect(registry.get(thread.id)!.plan!.closedAt).toBeUndefined();
    fleet.stop();
  });

  it("close when the lead's next turn ends without the answers, and take none then", async () => {
    const { fleet, registry, root, to, turn, planned } = project();
    const { coordinator, thread } = await planned();
    // the coordinator passes on a decision the person made in its conversation instead
    await fleet.send(thread.id, "The person chose five retries.");
    writeReport(root, thread.id, "ready", "Five retries.");
    await turn(thread, "idle");
    const run = registry.get(thread.id)!;
    expect(run.plan!.closedAt).toBeNumber();
    expect(JSON.parse(readFileSync(join(root, "fleet-plans", `${thread.id}.json`), "utf8")).closedAt).toBeNumber();
    expect(threadState(run)).toBe("review");
    await expect(fleet.answerPlan(thread.id, { version: 1 })).rejects.toMatchObject({ code: "plan_closed" });
    // a blocked turn after it asks about something else: the closed plan is not pointed to again
    await fleet.send(thread.id, "go on");
    writeReport(root, thread.id, "blocked", "Which branch?", "Which branch?");
    await turn(thread, "idle");
    // the coordinator, still on the first question's turn, hears it once that turn ends
    await turn(coordinator, "idle");
    expect(to(coordinator).at(-1)).toContain("asks the person: Which branch?");
    expect(to(coordinator).at(-1)).not.toContain("Plan tab");
    fleet.stop();
  });

  it("answered before the coordinator heard of them, are not passed on to it afterwards", async () => {
    const { fleet, registry, root, to, turn } = project();
    const coordinator = await fleet.startProject({ task: "go", cwd: "/repo" });
    // the coordinator is at work, so the thread's question waits for it
    const thread = await fleet.startThread({ title: "Fix", task: "t", cwd: "/repo", callerRun: coordinator.id });
    fleet.submitPlan(thread.id, PLAN);
    writeReport(root, thread.id, "blocked", "The plan waits for the person.", "Answer the plan in the Plan tab.");
    await turn(thread, "idle");
    expect(registry.get(thread.id)!.notice).toContain("Plan tab");
    await fleet.answerPlan(thread.id, { version: 1 });
    expect(registry.get(thread.id)!.notice).toBeUndefined();
    await turn(coordinator, "idle");
    expect(to(coordinator)).toEqual(["go"]);
    fleet.stop();
  });

  it("stay unanswered when the answers do not reach the lead: on its approval screen, or a prompt that failed", async () => {
    const { fleet, runtime, registry, root, planned } = project();
    const { thread } = await planned();
    const kept = () => JSON.parse(readFileSync(join(root, "fleet-plans", `${thread.id}.json`), "utf8"));
    runtime.promptImpl = async () => { throw new HerdrError("agent_blocked", "agent is blocked"); };
    await expect(fleet.answerPlan(thread.id, { version: 1, choices: { limit: "five" }, seen: ["limit"] })).rejects.toMatchObject({ code: "agent_blocked" });
    expect(kept().answeredAt).toBeUndefined();
    expect(registry.get(thread.id)!.plan!.answeredAt).toBeUndefined();
    // the person answered the approval: the same answers go now
    registry.get(thread.id)!.state = "idle";
    runtime.promptImpl = async () => { throw new HerdrError("pane_not_found", "pane gone"); };
    await expect(fleet.answerPlan(thread.id, { version: 1 })).rejects.toMatchObject({ code: "answer_not_delivered" });
    expect(kept().answeredAt).toBeUndefined();
    fleet.stop();
  });

  it("leave a newer plan the lead handed over while the answers went out as it is", async () => {
    const { fleet, runtime, registry, root, planned } = project();
    const { thread } = await planned();
    // the lead writes version 2 while the answers to version 1 are being typed into its pane
    runtime.promptImpl = async (name, text) => {
      runtime.prompts.push({ name, text });
      fleet.submitPlan(thread.id, { ...PLAN, title: "Retry limit, again" });
      return "working";
    };
    await fleet.answerPlan(thread.id, { version: 1, choices: { limit: "five" }, seen: ["limit"] });
    const kept = JSON.parse(readFileSync(join(root, "fleet-plans", `${thread.id}.json`), "utf8"));
    expect(kept).toMatchObject({ version: 2, title: "Retry limit, again" });
    expect(kept.answeredAt).toBeUndefined();
    expect(registry.get(thread.id)!.plan).toEqual({ version: 2, asks: 1 });
    fleet.stop();
  });

  it("are kept where the lead does not write, and one that does not hold together is refused, not drawn", async () => {
    const { fleet, root, planned } = project();
    const { coordinator, thread } = await planned();
    // a plan.json the lead wrote into its own result folder is not the fleet's
    writeFileSync(join(root, "results", thread.id, "plan.json"), JSON.stringify({ version: 9, writtenAt: 1, title: "Mine", claims: [{ text: "x", children: [] }], why: [], scope: [] }));
    expect(fleet.plan(thread.id).title).toBe("Retry limit");
    // the kept file, broken: refused as unreadable, and the rest of the fleet reads on
    writeFileSync(join(root, "fleet-plans", `${thread.id}.json`), JSON.stringify({ version: 1, writtenAt: 1, title: "t", claims: [{ text: { html: "<b>" } }] }));
    expect(() => fleet.plan(thread.id)).toThrow(expect.objectContaining({ code: "plan_unreadable" }));
    await expect(fleet.answerPlan(thread.id, { version: 1 })).rejects.toMatchObject({ code: "plan_unreadable" });
    expect((await fleet.threads({ callerRun: coordinator.id })).map((each) => each.run.id)).toEqual([thread.id]);
    // the lead hands it over again: the next version
    expect(fleet.submitPlan(thread.id, PLAN).version).toBe(2);
    fleet.stop();
  });

  it("come only from a thread's lead, and only plans that hold together", async () => {
    const { fleet, planned } = project();
    const { thread } = await planned();
    const helper = await spawn(fleet, { role: "reviewer" });
    expect(() => fleet.submitPlan(helper.id, PLAN, helper.group)).toThrow(expect.objectContaining({ code: "not_a_thread" }));
    expect(() => fleet.submitPlan(thread.id, { ...PLAN, claims: [{ text: "x", exhibit: { kind: "code", path: "../../etc/passwd", start: 1 } }] }))
      .toThrow("../../etc/passwd is not a file in the thread's worktree");
    expect(() => fleet.submitPlan(thread.id, { title: "t", claims: [] })).toThrow(expect.objectContaining({ code: "invalid_plan" }));
    expect(fleet.plan(thread.id).version).toBe(1);
    fleet.stop();
  });
});
