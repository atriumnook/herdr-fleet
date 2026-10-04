import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { adapterFor, isAgentKind, type AgentAdapter } from "./adapters.ts";
import { findAgent } from "./agents.ts";
import { makeGroupId, makeHerdrName, makeId, type RunRegistry } from "./registry.ts";
import { abortableDelay, abortError, FleetError, isAbortError, type AgentRuntime } from "./runtime.ts";
import { THINKING_LEVELS, requireThinkingLevel, type AgentDefinition, type AgentKind, type AgentRun, type AgentState, type FleetConfig, type RoleOverride, type SpawnRequest, type ThinkingLevel } from "./types.ts";
import { usageKey, type UsageTracker } from "./usage.ts";

/** One delegated turn, from the prompt until it settles. */
interface PendingTurn {
  armed: boolean;
  /** a blocked turn was already reported to waiters; reset when it works again */
  blockedReported: boolean;
  generation: number;
  /** when the prompt was handed to herdr; undefined until then */
  submittedAt?: number;
  /** herdr reported `working` for this turn at least once */
  sawWorking: boolean;
}

/** the most of a result file a run keeps: a handoff, not a transcript */
export const RESULT_MAX_BYTES = 64 * 1024;
const RESULT_FILE = "handoff.md";

/** A spawn whose configured fallbacks (candidate entries) are still untried: consulted if its first turn fails. */
interface SpawnPlan { request: SpawnRequest & { group: string }; fallbacks: string[] }

export const isCompleted = (state: AgentState): boolean => state === "idle" || state === "done";
export const isLive = (run: AgentRun): boolean => run.state !== "stopped" && run.state !== "failed";

/**
 * herdr reports the state from before the prompt (usually `idle`) for a moment after it is
 * submitted: the text is still being pasted and the TUI has not flipped to working. A settled
 * state seen in this window, before the turn was ever seen working, is not a completion.
 */
export const PRE_VISUAL_GRACE_MS = 2_500;
/** how long a CLI herdr already calls ready may take to draw its input (adapter.inputReady) */
export const READY_SCREEN_MS = 15_000;
const READY_SCREEN_POLL_MS = 250;
/** how long a CLI's usage screen (cursor's `/usage`) may take to show */
export const USAGE_SCREEN_MS = 10_000;
/** a run still `starting` may be inside a 30 s agent start: not-found is not its end yet */
const START_GRACE_MS = 30_000;

export class AgentWaitTimeoutError extends Error {
  constructor(readonly run: AgentRun, readonly timeoutMs: number) {
    super(`Wait timed out after ${timeoutMs}ms; ${run.name} is still ${run.state}.`);
    this.name = "AgentWaitTimeoutError";
  }
}

export interface OrchestratorDeps {
  runtime: AgentRuntime;
  registry: RunRegistry;
  /** the config that applies in a folder: built-ins, the user's, the project's */
  config: (cwd: string) => FleetConfig;
  /** the roles that exist in a folder */
  agents: (cwd: string) => AgentDefinition[];
  /** the shell command an agent runs to reach the fleet (bin/fleet.ts) */
  fleetCommand: string;
  /** set in each agent's pane so its own fleet commands reach this server; read at each spawn */
  agentEnv: () => Record<string, string>;
  /** each run's result folder goes here, removed with the run's record */
  resultsDir: string;
  /**
   * instructions still to lead the first prompt of a CLI that takes none at launch, a file per run
   * so a restart keeps them; apart from the result folders, which agents may write
   */
  instructionsDir: string;
  /** where the per-spawn instruction files go; os.tmpdir() unless a test says otherwise */
  promptDir?: string;
  /** PRE_VISUAL_GRACE_MS; tests shorten it */
  preVisualGraceMs?: number;
  /** READY_SCREEN_MS; tests shorten it */
  readyScreenMs?: number;
  /** USAGE_SCREEN_MS; tests shorten it */
  usageScreenMs?: number;
  /** what each account has used: candidates without usage left are skipped, rate limits start cooldowns */
  usage?: Pick<UsageTracker, "unavailable" | "noteFailure" | "claimScreen" | "record">;
  onChanged?: (run: AgentRun) => void;
}

/**
 * A candidate entry: `<agent>:<model>` names another CLI, anything else is a model of the role's
 * own. A model's `:level` suffix stays with the model (`codex:gpt-6:high`).
 */
export function parseCandidate(entry: string | undefined, kind: AgentKind): { agent: AgentKind; model?: string } {
  const colon = entry?.indexOf(":") ?? -1;
  const prefix = colon > 0 ? entry!.slice(0, colon) : undefined;
  if (prefix && isAgentKind(prefix)) return { agent: prefix, model: entry!.slice(colon + 1) || undefined };
  return { agent: kind, model: entry };
}

function shortModel(model?: string): string {
  if (!model) return "default";
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * Starts agents in herdr panes and follows each delegated turn until it settles. herdr's status
 * events (forwarded by the server's collector) are wake-ups only: the state acted on is always
 * read back from herdr first, so a replayed or reordered event cannot move a run backwards.
 */
export class Orchestrator {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly generations = new Map<string, number>();
  private readonly reconcileLocks = new Map<string, Promise<void>>();
  private readonly settleChecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly spawnPlans = new Map<string, SpawnPlan>();
  /** callers waiting for a run's turn to settle or block */
  private readonly waiters = new Map<string, Set<(run: AgentRun) => void>>();
  /** the concurrency check and the run's first save happen as one step */
  private spawnGate: Promise<void> = Promise.resolve();
  private stopped = false;

  private readonly grace: number;
  private readonly readyScreenMs: number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.grace = deps.preVisualGraceMs ?? PRE_VISUAL_GRACE_MS;
    this.readyScreenMs = deps.readyScreenMs ?? READY_SCREEN_MS;
    this.pruneResults();
    // a restart read the runs back without their results: the result files hold them
    for (const run of deps.registry.all()) run.result ??= readResult(this.resultFile(run));
  }

  /** A result folder outlives its pane but not its run: once the registry dropped the run, it goes. So do undelivered instructions. */
  private pruneResults(): void {
    for (const dir of [this.deps.resultsDir, this.deps.instructionsDir]) {
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) if (!this.deps.registry.get(name.replace(/\.md$/, ""))) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }

  private undeliveredFile(run: AgentRun): string {
    return join(this.deps.instructionsDir, `${run.id}.md`);
  }

  private undelivered(run: AgentRun): string | undefined {
    try { return readFileSync(this.undeliveredFile(run), "utf8"); } catch { return undefined; }
  }

  private dropUndelivered(run: AgentRun): void {
    rmSync(this.undeliveredFile(run), { force: true });
  }

  private resultFile(run: AgentRun): string {
    return join(this.deps.resultsDir, run.id, RESULT_FILE);
  }

  list(group?: string): AgentRun[] {
    return this.deps.registry.all().filter((run) => group === undefined || run.group === group).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The roles a spawn in `cwd` can name. */
  roles(cwd: string): AgentDefinition[] {
    return this.deps.agents(cwd);
  }

  get(target: string, group?: string): AgentRun {
    const run = this.deps.registry.resolve(target, group);
    if (!run) throw new FleetError("run_not_found", `Unknown fleet agent: ${target}`);
    return run;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.settleChecks.values()) clearTimeout(timer);
    this.settleChecks.clear();
  }

  // ---- spawn -------------------------------------------------------------------------------

  async spawn(request: SpawnRequest, signal?: AbortSignal): Promise<AgentRun> {
    const group = request.group ?? makeGroupId();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(group)) throw new FleetError("invalid_group", "group must be letters, digits, - and _ (up to 48)");
    return this.spawnWithFallbacks({ ...request, group }, signal);
  }

  /**
   * The primary candidate, then each configured fallback in order. A candidate whose account has
   * no usage left or is cooling down is skipped; one that fails to start (the CLI quit with an
   * error before it was ready) moves on to the next, and a rate limit it quit on starts a cooldown.
   * Every other error is the caller's. `fallbacks` replaces the configured list for a re-spawn after
   * a failed first turn, so candidates already tried are not tried again.
   */
  private async spawnWithFallbacks(request: SpawnRequest & { group: string }, signal?: AbortSignal, fallbacks?: string[], fallbackFrom?: string): Promise<AgentRun> {
    const cwd = resolve(request.cwd ?? process.cwd());
    const config = this.deps.config(cwd);
    const depth = request.depth ?? 0;
    if (depth >= config.maxDepth) throw new FleetError("depth_limit", `Agent nesting limit reached: depth=${depth}, maxDepth=${config.maxDepth}`);
    const agents = this.deps.agents(cwd);
    const definition = findAgent(agents, request.role);
    if (!definition) throw new FleetError("unknown_role", `Unknown agent role: ${request.role}. Available: ${agents.map((a) => a.name).join(", ")}`);
    const override = config.roles[definition.name] ?? config.roles[request.role] ?? {};
    const primary = request.model ?? override.model ?? definition.model ?? config.defaultModel;
    const explicitThinking = request.thinking !== undefined ? request.thinking : override.thinking ?? definition.thinking;
    const baseThinking = requireThinkingLevel(explicitThinking ?? config.defaultThinking);
    const roleKind = override.agent ?? definition.agent;
    const candidates: Array<string | undefined> = [primary, ...(fallbacks ?? override.fallbackModels ?? definition.fallbackModels ?? []).filter((m) => m !== primary)];
    const failures: string[] = [];
    let started = false;
    for (let i = 0; i < candidates.length; i++) {
      const entry = candidates[i];
      const { agent: kind, model } = parseCandidate(entry, roleKind);
      const last = i === candidates.length - 1;
      const unusable = await this.deps.usage?.unavailable(kind, model, config.maxUsedPercent);
      if (unusable) {
        failures.push(`${entry ?? "default"}: ${unusable}`);
        if (!last) continue;
        throw new FleetError(started ? "fallbacks_exhausted" : "usage_exhausted", `No candidate has usage left: ${failures.join("; ")}`);
      }
      // a fallback is bounded by its own allow-list rather than refused: a person listed it
      const thinking = applyModelPolicy(config, model, baseThinking, i === 0 && explicitThinking !== undefined);
      try {
        started = true;
        return await this.spawnAttempt({ ...request, cwd }, config, definition, override, kind, model, thinking,
          candidates.slice(i + 1).filter((m): m is string => !!m), i === 0 ? fallbackFrom : candidates[i - 1] ?? fallbackFrom, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        const modelFailure = error instanceof FleetError && error.code === "agent_start_failed";
        if (modelFailure) this.deps.usage?.noteFailure(kind, model, reason, config.rateLimitCooldownMinutes);
        if (!modelFailure || last) {
          if (!failures.length) throw error;
          throw new FleetError("fallbacks_exhausted", `${reason}. Fallbacks exhausted: ${failures.join("; ")}`);
        }
        failures.push(`${entry ?? "default"}: ${reason}`);
      }
    }
    throw new FleetError("no_candidates", "No model candidates to spawn.");
  }

  private async spawnAttempt(request: SpawnRequest & { cwd: string; group: string }, config: FleetConfig, definition: AgentDefinition, override: RoleOverride,
    kind: AgentKind, model: string | undefined, thinking: ThinkingLevel | undefined, fallbacks: string[], fallbackFrom: string | undefined, signal?: AbortSignal): Promise<AgentRun> {
    const adapter = adapterFor(kind);
    const depth = (request.depth ?? 0) + 1;
    const worktree = request.worktree ?? override.worktree ?? definition.worktree ?? false;
    const interactive = request.interactive ?? override.interactive ?? definition.interactive ?? false;
    // a child may spawn only when its role says so and its own children would still fit under maxDepth
    const canSpawn = (override.spawning ?? definition.spawning ?? false) && depth < config.maxDepth;
    const id = makeId();
    const herdrName = makeHerdrName(request.group, definition.name, id);
    const displayName = request.name?.trim() || definition.name;
    const env = { ...this.deps.agentEnv(), HERDR_FLEET_GROUP: request.group, HERDR_FLEET_DEPTH: String(depth) };

    // the budget counts runs across fleets: the check and the first save must not interleave
    const previousGate = this.spawnGate;
    let releaseGate!: () => void;
    this.spawnGate = new Promise<void>((resolveGate) => { releaseGate = resolveGate; });
    if (signal?.aborted) { releaseGate(); throw abortError(signal); }
    await previousGate;
    let run: AgentRun;
    try {
      if (signal?.aborted) throw abortError(signal);
      const active = this.deps.registry.all().filter((r) => r.state === "starting" || r.state === "working");
      if (active.length >= config.maxConcurrent) throw new FleetError("concurrency_limit", `Agent concurrency limit reached: ${active.length}/${config.maxConcurrent}`);
      const location = await this.deps.runtime.createLocation({
        cwd: request.cwd, label: displayName, worktree, branch: worktree ? `agents/${definition.name}-${id}` : undefined,
        direction: request.direction, callerPaneId: request.callerPaneId, env,
      }, signal);
      const now = Date.now();
      run = {
        id, name: displayName, role: definition.name, agent: kind, group: request.group, herdrName, paneId: location.paneId, workspaceId: location.workspaceId,
        cwd: location.cwd, model, thinking, fallbackFrom, state: "starting", depth, interactive, worktree, startedAt: now, updatedAt: now,
      };
      this.save(run);
    } finally {
      releaseGate();
    }

    // the agent writes each turn's handoff here: a folder of its own, outside any workspace
    const resultDir = join(this.deps.resultsDir, run.id);
    mkdirSync(this.deps.resultsDir, { recursive: true, mode: 0o700 });
    mkdirSync(resultDir, { mode: 0o700 });
    const instructions = this.instructions(definition, displayName, request.group, canSpawn, join(resultDir, RESULT_FILE));
    if (adapter.instructionsInPrompt) {
      mkdirSync(this.deps.instructionsDir, { recursive: true, mode: 0o700 });
      writeFileSync(this.undeliveredFile(run), instructions, { mode: 0o600 });
    }
    // herdr refuses multiline argv: the instructions go to the agent as a file it reads at startup
    const promptDir = mkdtempSync(join(this.deps.promptDir ?? tmpdir(), "herdr-fleet-"));
    const promptFile = join(promptDir, "instructions.md");
    writeFileSync(promptFile, instructions, { mode: 0o600 });
    let notReady = false;
    try {
      try {
        run.state = await this.deps.runtime.start({
          kind, name: herdrName, paneId: run.paneId, signal, startupError: (screen) => adapter.startupError(screen),
          args: adapter.launchArgs({ model, thinking, tools: definition.tools, name: displayName, systemPromptFile: promptFile, systemPrompt: instructions, resultDir }),
        });
        if (run.state === "blocked") run.lastError = "Agent stopped at a question before its first prompt; the task has not been sent.";
        else if (adapter.question || adapter.readyError) {
          // herdr calls some CLIs ready while they still ask something, or after they ignored the model
          const screen = await this.readyScreen(adapter, herdrName, config, signal);
          const error = adapter.readyError?.(screen);
          if (error) throw new FleetError("agent_start_failed", error);
          const question = adapter.question?.(screen);
          if (question) {
            run.state = "blocked";
            run.lastError = `${question} The task has not been sent.`;
          }
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof FleetError && error.code === "agent_not_ready") {
          notReady = true;
          run.state = await this.deps.runtime.get(herdrName).catch(() => "unknown" as const);
          run.lastError = "Agent started but is not ready for prompts; the task has not been sent.";
        } else {
          run.state = "failed";
          run.lastError = error instanceof Error ? error.message : String(error);
          run.updatedAt = Date.now();
          this.dropUndelivered(run);
          this.save(run);
          // the agent never started: an empty pane left behind would be an orphan
          await this.deps.runtime.closePane(run.paneId).catch(() => undefined);
          throw error;
        }
      }
      run.updatedAt = Date.now();
      this.save(run);
      await this.deps.runtime.reportMetadata({
        paneId: run.paneId, title: displayName, displayAgent: `${run.role}: ${displayName}`,
        tokens: { fleet: request.group.replace(/^fleet-/, ""), role: run.role, model: shortModel(run.model) },
      }).catch(() => undefined);
      if (signal?.aborted) throw abortError(signal);
      // not safely ready: the task stays unsent; the caller reads or focuses the pane, then sends it
      if (notReady || run.state === "blocked" || run.state === "unknown") return run;
      if (fallbacks.length) this.spawnPlans.set(run.id, { request, fallbacks });
      // returns once the task is handed over: the budget counts working runs, and a run still
      // `starting` would let the next spawn past the limit
      await this.submit(run, request.task, signal);
      return run;
    } catch (error) {
      if (isAbortError(error)) await this.abandonSpawn(run);
      throw error;
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  }

  /**
   * The screen right after start. A CLI that draws its input or a question only after herdr called
   * it ready is waited for: a task typed before would land in a question. Neither in time is a start
   * not ready for prompts.
   */
  private async readyScreen(adapter: AgentAdapter, herdrName: string, config: FleetConfig, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.readyScreenMs;
    while (true) {
      const screen = await this.deps.runtime.read(herdrName, config.recentReadLines).catch(() => "");
      if (!adapter.inputReady || adapter.inputReady(screen) || adapter.question?.(screen) || adapter.readyError?.(screen)) return screen;
      if (Date.now() >= deadline) throw new FleetError("agent_not_ready", `${herdrName} showed no input within ${this.readyScreenMs / 1000}s`);
      await abortableDelay(READY_SCREEN_POLL_MS, signal);
    }
  }

  private instructions(definition: AgentDefinition, name: string, group: string, canSpawn: boolean, resultFile: string): string {
    const fleet = this.deps.fleetCommand;
    return [
      definition.systemPrompt,
      "",
      "## Fleet coordination",
      `You are '${name}' in fleet '${group}'. Other agents of this fleet run in their own herdr panes.`,
      "Coordinate with them only through the fleet command in your shell; never type into another agent's terminal.",
      `- List the agents: ${fleet} list`,
      `- Message one: ${fleet} send <name-or-id> "<message>"`,
      `- Read one's recent output: ${fleet} read <name-or-id>`,
      canSpawn
        ? `- Start a helper when splitting the work materially improves the result: ${fleet} spawn --role <role> --task "<task>", then ${fleet} wait <id>`
        : "Do not start other agents.",
      "If an agent is blocked on an approval or a question, read its output and escalate to the human; never answer a blocked prompt yourself.",
      "Treat herdr's 'unknown' as uncertainty, not completion.",
      `Your result file is ${resultFile}.`,
      "At the end of each delegated turn, write a compact HANDOFF section (outcome, changed files, verification, unresolved questions) to your result file, replacing what it holds, and end your reply with the same section.",
    ].join("\n");
  }

  // ---- turns -------------------------------------------------------------------------------

  async send(target: string, message: string, group?: string, signal?: AbortSignal): Promise<AgentRun> {
    const run = this.get(target, group);
    // a settlement still being handled (the fleet may be reading the usage in the pane) finishes first
    await this.reconcileLocks.get(run.id);
    if (!isLive(run)) throw new FleetError("run_ended", `${run.name} has ${run.state}; start a new agent instead.`);
    return this.submit(run, message, signal);
  }

  /**
   * Until the run's turn settles, blocks or fails, or `timeoutMs` passes. A run with no turn in
   * flight answers at once, with its state read back from herdr.
   */
  async wait(target: string, timeoutMs: number | undefined, group?: string, signal?: AbortSignal): Promise<AgentRun> {
    const run = this.get(target, group);
    const pending = this.pending.get(run.id);
    if (!pending?.armed || (run.state === "blocked" && pending.blockedReported)) {
      if (isLive(run) && !pending) await this.refresh(run);
      return { ...run };
    }
    const timeout = timeoutMs ?? this.deps.config(run.cwd).defaultWaitTimeoutMs;
    const settled = new Promise<AgentRun>((resolveWait, rejectWait) => {
      const listeners = this.waiters.get(run.id) ?? new Set();
      this.waiters.set(run.id, listeners);
      const done = (value: AgentRun) => { cleanup(); resolveWait(value); };
      const timer = setTimeout(() => { cleanup(); void this.refresh(run).finally(() => rejectWait(new AgentWaitTimeoutError({ ...run }, timeout))); }, timeout);
      const onAbort = () => { cleanup(); rejectWait(abortError(signal)); };
      const cleanup = () => { clearTimeout(timer); listeners.delete(done); signal?.removeEventListener("abort", onAbort); };
      listeners.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // a wait is a good moment to look: an event may have been missed
    void this.reconcileRun(run);
    return settled;
  }

  async read(target: string, lines: number | undefined, group?: string): Promise<string> {
    const run = this.get(target, group);
    return this.deps.runtime.read(run.herdrName, lines ?? this.deps.config(run.cwd).recentReadLines);
  }

  async interrupt(target: string, group?: string): Promise<AgentRun> {
    const run = this.get(target, group);
    await this.deps.runtime.interrupt(run.herdrName);
    await this.refresh(run);
    return { ...run };
  }

  async focus(target: string, group?: string): Promise<AgentRun> {
    const run = this.get(target, group);
    await this.deps.runtime.focus(run.herdrName);
    return { ...run };
  }

  /** Closes the panes of finished non-interactive runs herdr still reports as done; never blocked or in-flight ones. */
  async closeDone(group?: string): Promise<AgentRun[]> {
    const closed: AgentRun[] = [];
    for (const run of this.list(group)) {
      if (run.interactive || run.state !== "done" || this.pending.has(run.id)) continue;
      if (await this.liveState(run) !== "done") continue;
      if (await this.closeSettledPane(run)) closed.push({ ...run });
    }
    return closed;
  }

  private async submit(run: AgentRun, text: string, signal?: AbortSignal): Promise<AgentRun> {
    if (signal?.aborted) throw abortError(signal);
    this.clearSettleCheck(run.id);
    const generation = (this.generations.get(run.id) ?? 0) + 1;
    this.generations.set(run.id, generation);
    const pending: PendingTurn = { armed: false, blockedReported: false, generation, sawWorking: false };
    this.pending.set(run.id, pending);
    // a result file found when the turn settles is this turn's
    rmSync(this.resultFile(run), { force: true });
    const instructions = this.undelivered(run);
    try {
      const submitted = await this.deps.runtime.prompt(run.herdrName, instructions ? `${instructions}\n\n## Task\n\n${text}` : text, signal);
      this.dropUndelivered(run);
      // herdr still shows the state from before the prompt: the turn IS running, so it counts as
      // working (the budget, the UI) until herdr reports a real settlement
      this.updateState(run, submitted === "idle" || submitted === "unknown" || submitted === "done" ? "working" : submitted);
      pending.armed = true;
      pending.submittedAt = Date.now();
      pending.sawWorking = submitted === "working";
      if (submitted !== "working") {
        // a turn fast enough to settle before the TUI ever flips may send no further event: look
        // again after the grace period. Keyed by generation, so a follow-up send never inherits it.
        const timer = setTimeout(() => {
          this.settleChecks.delete(run.id);
          if (this.pending.get(run.id)?.generation === generation) void this.reconcileRun(run);
        }, this.grace);
        this.settleChecks.set(run.id, timer);
      }
      return { ...run };
    } catch (error) {
      this.dropPending(run.id);
      if (isAbortError(error)) throw error;
      if (error instanceof HerdrError && error.code === "agent_blocked") {
        // herdr refused before typing anything: nothing is in flight; the caller retries once a person answered
        run.lastOutput = await this.deps.runtime.read(run.herdrName, this.deps.config(run.cwd).recentReadLines).catch(() => undefined);
        this.updateState(run, "blocked");
        return { ...run };
      }
      run.state = "failed";
      run.lastError = error instanceof Error ? error.message : String(error);
      run.updatedAt = Date.now();
      this.save(run);
      return { ...run };
    }
  }

  // ---- herdr events (from the server's status collector) -----------------------------------

  /** A pane's agent status changed: a wake-up to read the run's state back from herdr. */
  onPaneStatus(paneId: string): void {
    const run = this.deps.registry.byPane(paneId);
    if (run && isLive(run)) void this.reconcileRun(run);
  }

  /** A pane exited or closed: its run is over. A run that already failed keeps that verdict. */
  onPaneEnded(paneId: string): void {
    const run = this.deps.registry.byPane(paneId);
    if (!run || !isLive(run)) return;
    run.state = "stopped";
    run.updatedAt = Date.now();
    this.dropPending(run.id);
    this.save(run);
    this.settleWaiters(run);
  }

  /** Events may have been lost (a reconnect, a restart): every live run is read back. */
  async reconcileAll(): Promise<void> {
    for (const run of this.list().filter(isLive)) await this.reconcileRun(run);
  }

  private async reconcileRun(run: AgentRun): Promise<void> {
    const previous = this.reconcileLocks.get(run.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.stopped) return;
      try {
        if (!isLive(run)) return;
        const reported = await this.deps.runtime.get(run.herdrName);
        // the pane ended while herdr was asked: what it said is older than that
        if (!isLive(run)) return;
        const pending = this.pending.get(run.id);
        if (pending && reported === "working") pending.sawWorking = true;
        // the paste is still going and herdr still answers with the idle from before: not a
        // settlement. The check scheduled at submission looks again after the grace period.
        if (pending?.armed && !pending.sawWorking && isCompleted(reported) && pending.submittedAt !== undefined && Date.now() - pending.submittedAt < this.grace) return;
        const current = await this.observed(run, reported);
        if (!isLive(run)) return;
        if (current !== run.state) this.updateState(run, current);
        if (pending?.armed && run.state === "blocked") await this.reportBlocked(run, pending);
        else if (pending?.armed && isCompleted(run.state)) await this.finalize(run, pending);
      } catch (error) {
        if (error instanceof HerdrError && (error.code === "agent_not_found" || error.code === "not_found" || error.code === "pane_not_found")) {
          if (run.state === "starting" && Date.now() - run.startedAt < START_GRACE_MS) return;
          run.state = "stopped";
          run.updatedAt = Date.now();
          this.dropPending(run.id);
          this.save(run);
          this.settleWaiters(run);
        }
      }
    });
    this.reconcileLocks.set(run.id, next);
    try { await next; } finally { if (this.reconcileLocks.get(run.id) === next) this.reconcileLocks.delete(run.id); }
  }

  private async finalize(run: AgentRun, pending: PendingTurn): Promise<void> {
    if (this.pending.get(run.id)?.generation !== pending.generation) return;
    this.dropPending(run.id);
    const config = this.deps.config(run.cwd);
    run.lastOutput = await this.deps.runtime.read(run.herdrName, config.recentReadLines).catch(() => undefined);
    run.result = readResult(this.resultFile(run));
    // an API failure (auth, rate limit, outage) ends a turn like any other once the CLI's own retries
    // are spent; a turn that wrote its handoff did its work, whatever its screen quotes
    const turnError = run.result === undefined ? adapterFor(run.agent).turnError(run.lastOutput) : undefined;
    if (turnError && isCompleted(run.state)) {
      run.state = "failed";
      run.lastError = turnError;
      // a rate limit sits the account out: the re-spawn below and later spawns pass it over
      this.deps.usage?.noteFailure(run.agent, run.model, turnError, config.rateLimitCooldownMinutes);
    }
    run.updatedAt = Date.now();
    this.save(run);
    if (isCompleted(run.state)) await this.readUsageScreen(run, config);
    const plan = this.spawnPlans.get(run.id);
    this.spawnPlans.delete(run.id);
    if (run.state === "failed" && plan && pending.generation === 1) await this.respawn(run, plan);
    this.settleWaiters(run);
    await this.closeOnSettle(run, config);
  }

  /**
   * The first turn failed on a model that has configured fallbacks left: the same task starts again
   * on the next one, and the failed run names its replacement. Later turns are not retried: by
   * then the agent holds state a replacement would not have.
   */
  private async respawn(run: AgentRun, plan: SpawnPlan): Promise<void> {
    const [next, ...rest] = plan.fallbacks;
    if (!next) return;
    try {
      const replacement = await this.spawnWithFallbacks({ ...plan.request, model: next, thinking: undefined }, undefined, rest, run.model);
      run.replacedBy = replacement.id;
    } catch (error) {
      run.lastError = `${run.lastError ?? "failed"}; the configured fallback could not start: ${error instanceof Error ? error.message : String(error)}`;
    }
    run.updatedAt = Date.now();
    this.save(run);
  }

  /**
   * A CLI that shows its usage only on its own screen (cursor's `/usage`) is asked once a turn
   * settled, when neither the last reading nor the last try is recent: the command is typed, the
   * screen read until the usage shows, and Esc closes it. Never in an interactive run's pane, where
   * a person may be typing. This runs inside the run's reconcile lock and before the waiters hear of
   * the settlement; send() waits for that lock, so neither herdr's events nor a next task interleave.
   * It ends once herdr calls the CLI settled again, so the pane is not taken for a working one.
   */
  private async readUsageScreen(run: AgentRun, config: FleetConfig): Promise<void> {
    const adapter = adapterFor(run.agent);
    const usage = this.deps.usage;
    if (run.interactive || !usage || !adapter.usageCommand || !adapter.usageScreen || !usage.claimScreen(run.agent, run.model)) return;
    const wait = this.deps.usageScreenMs ?? USAGE_SCREEN_MS;
    try {
      await this.deps.runtime.prompt(run.herdrName, adapter.usageCommand);
      const deadline = Date.now() + wait;
      while (Date.now() < deadline) {
        await Bun.sleep(READY_SCREEN_POLL_MS);
        const reading = adapter.usageScreen(await this.deps.runtime.read(run.herdrName, config.recentReadLines).catch(() => ""), Date.now());
        if (reading) { usage.record(usageKey(run.agent, run.model), reading); break; }
      }
    } catch {
      // the usage is a hint for later spawns; this turn's outcome stands without it
    } finally {
      await this.deps.runtime.interrupt(run.herdrName).catch(() => undefined);
      const deadline = Date.now() + wait;
      while (Date.now() < deadline && !isCompleted(await this.deps.runtime.get(run.herdrName).catch(() => "idle" as const))) await Bun.sleep(READY_SCREEN_POLL_MS);
    }
  }

  private async reportBlocked(run: AgentRun, pending: PendingTurn): Promise<void> {
    if (pending.blockedReported) return;
    pending.blockedReported = true;
    run.lastOutput = await this.deps.runtime.read(run.herdrName, this.deps.config(run.cwd).recentReadLines).catch(() => undefined);
    run.updatedAt = Date.now();
    this.save(run);
    this.settleWaiters(run);
  }

  private async closeOnSettle(run: AgentRun, config: FleetConfig): Promise<void> {
    if (!config.closeOnSettle || run.interactive || !isCompleted(run.state) || this.pending.has(run.id)) return;
    const live = await this.liveState(run);
    if (live && isCompleted(live)) await this.closeSettledPane(run);
  }

  private async closeSettledPane(run: AgentRun): Promise<boolean> {
    try { await this.deps.runtime.closePane(run.paneId); } catch { return false; }
    run.state = "stopped";
    run.updatedAt = Date.now();
    this.dropPending(run.id);
    this.save(run);
    return true;
  }

  /**
   * herdr's state, corrected for a question herdr takes for idle (cursor's and agy's trust and
   * approval screens): while one shows, the run is blocked, at startup and mid-turn alike.
   */
  private async observed(run: AgentRun, reported: AgentState): Promise<AgentState> {
    const adapter = adapterFor(run.agent);
    if (!isCompleted(reported) || !adapter.question) return reported;
    const screen = await this.deps.runtime.read(run.herdrName, this.deps.config(run.cwd).recentReadLines).catch(() => "");
    return adapter.question(screen) ? "blocked" : reported;
  }

  /** herdr's state for the run now; undefined when herdr cannot say (never a reason to close a pane). */
  private async liveState(run: AgentRun): Promise<AgentState | undefined> {
    try {
      const current = await this.observed(run, await this.deps.runtime.get(run.herdrName));
      if (!isLive(run)) return undefined;
      if (current !== run.state) this.updateState(run, current);
      return current;
    } catch {
      return undefined;
    }
  }

  private async refresh(run: AgentRun): Promise<void> {
    await this.liveState(run);
  }

  private settleWaiters(run: AgentRun): void {
    const listeners = this.waiters.get(run.id);
    if (!listeners?.size) return;
    const snapshot = { ...run };
    for (const listener of [...listeners]) listener(snapshot);
  }

  private async abandonSpawn(run: AgentRun): Promise<void> {
    this.dropPending(run.id);
    this.dropUndelivered(run);
    await this.deps.runtime.closePane(run.paneId).catch(() => undefined);
    run.state = "stopped";
    run.lastError = "Spawn cancelled.";
    run.updatedAt = Date.now();
    this.save(run);
  }

  private clearSettleCheck(runId: string): void {
    const timer = this.settleChecks.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.settleChecks.delete(runId);
  }

  private dropPending(runId: string): void {
    this.pending.delete(runId);
    this.clearSettleCheck(runId);
  }

  private updateState(run: AgentRun, state: AgentState): void {
    const previous = run.state;
    run.state = state;
    // working again after a question: a later block is news again
    if (state === "working" && previous === "blocked") {
      const pending = this.pending.get(run.id);
      if (pending) pending.blockedReported = false;
    }
    run.updatedAt = Date.now();
    this.save(run);
  }

  private save(run: AgentRun): void {
    this.deps.registry.upsert(run);
    this.deps.onChanged?.(run);
  }
}

/**
 * The handoff a run's agent wrote, up to RESULT_MAX_BYTES. Only a regular file is read, never one
 * reached through a symlink: an agent must not turn the result into a way to read other files.
 */
export function readResult(file: string): string | undefined {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(RESULT_MAX_BYTES);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const text = buffer.subarray(0, length).toString("utf8").trim();
    if (!text) return undefined;
    return length === RESULT_MAX_BYTES ? `${text}\n[truncated at ${RESULT_MAX_BYTES} bytes]` : text;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * `models.<model>.thinking` is the allow-list for that model. A level chosen explicitly (the spawn
 * request, a role override, the role file) outside it is refused so the caller decides again; a
 * level inherited from defaults is lowered to the highest allowed one. A `:level` suffix on the
 * model is the effective level and is checked the same way.
 */
export function applyModelPolicy(config: FleetConfig, model: string | undefined, thinking: ThinkingLevel | undefined, explicit: boolean): ThinkingLevel | undefined {
  if (!model) return thinking;
  const match = /^(.*):(off|minimal|low|medium|high|xhigh|max)$/.exec(model);
  const baseModel = match ? match[1]! : model;
  const effective = match ? (match[2] as ThinkingLevel) : thinking;
  const allowed = config.models[baseModel]?.thinking;
  if (!allowed?.length) return effective;
  if (effective !== undefined && allowed.includes(effective)) return effective;
  if (explicit || match) throw new FleetError("thinking_not_allowed", `Thinking level "${effective}" is not allowed for ${baseModel}. Allowed: ${allowed.join(", ")}.`);
  return [...THINKING_LEVELS].reverse().find((level) => allowed.includes(level))!;
}
