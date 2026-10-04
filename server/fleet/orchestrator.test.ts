import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { DEFAULT_CONFIG, mergeConfig } from "./config.ts";
import { AgentWaitTimeoutError, applyModelPolicy, Orchestrator, readResult, RESULT_MAX_BYTES } from "./orchestrator.ts";
import { RunRegistry } from "./registry.ts";
import { abortableDelay, abortError, FleetError, type AgentMetadata, type AgentRuntime, type CreateLocationOptions, type RuntimeLocation, type StartOptions } from "./runtime.ts";
import type { AgentDefinition, AgentState, FleetConfig } from "./types.ts";

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
  async interrupt(): Promise<void> {}
  async focus(): Promise<void> {}
  async reportMetadata(_metadata: AgentMetadata): Promise<void> {}
}

const role = (name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name, description: name, agent: "pi", systemPrompt: `You are ${name}.`, source: "bundled", filePath: `${name}.md`, ...extra,
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(options: { config?: Partial<FleetConfig> | Record<string, unknown>; agents?: AgentDefinition[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fleet-orchestrator-"));
  roots.push(root);
  const runtime = new FakeRuntime();
  const registry = new RunRegistry(join(root, "runs.json"));
  const config = mergeConfig(DEFAULT_CONFIG, options.config as Record<string, unknown> ?? {});
  const fleet = new Orchestrator({
    runtime, registry, config: () => config, agents: () => options.agents ?? [role("worker"), role("reviewer", { interactive: true })],
    fleetCommand: "fleet", agentEnv: () => ({ HERDR_FLEET_URL: "http://127.0.0.1:1" }), promptDir: root, resultsDir: join(root, "results"), preVisualGraceMs: GRACE, readyScreenMs: 300,
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
    expect(runtime.locations[0]).toMatchObject({ cwd: "/work", callerPaneId: "w0:p1", env: { HERDR_FLEET_URL: "http://127.0.0.1:1", HERDR_FLEET_GROUP: "g1", HERDR_FLEET_DEPTH: "1" } });
    expect(runtime.starts[0]!.args).toContain("--append-system-prompt");
    expect(runtime.instructions[0]).toContain("You are worker.");
    expect(runtime.instructions[0]).toContain("fleet send <name-or-id>");
    expect(runtime.instructions[0]).toContain("Do not start other agents.");
    expect(runtime.prompts).toEqual([{ name: run.herdrName, text: "do it" }]);
    // the instruction file is gone once the agent has read it at startup
    expect(require("node:fs").readdirSync(root).filter((name: string) => name.startsWith("herdr-fleet-"))).toEqual([]);
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
    await expect(spawn(fleet, { depth: 2 })).rejects.toMatchObject({ code: "depth_limit" });
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

  it("removes the result folders of runs the registry no longer has", async () => {
    const { fleet, runtime, registry, root } = setup();
    const run = await spawn(fleet);
    mkdirSync(join(root, "results", "gone1"));
    new Orchestrator({
      runtime, registry, config: () => DEFAULT_CONFIG, agents: () => [], fleetCommand: "fleet", agentEnv: () => ({}), resultsDir: join(root, "results"), promptDir: root,
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
