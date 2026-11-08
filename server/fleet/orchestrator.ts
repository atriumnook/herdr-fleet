import { closeSync, constants, copyFileSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { adapterFor, isAgentKind, type AgentAdapter } from "./adapters.ts";
import { contentHash, findAgent, roleVersion } from "./agents.ts";
import { checkBrief, overlap, renderBrief, writeScope, type Brief } from "./brief.ts";
import { contractItems, FROM_PANE, outcomeLine, threadState, type GateReading, type LandAction, type LandingChecks, type LandingStep, type LineComment, type MergeBy, type PullRequest } from "../../shared/fleet.ts";
import { compareOnGitHub, headCommit, mergeCommitOf, onGitHub, readPullRequest, revertOf, worktreeState, type PullRequestReading } from "./github.ts";
import { evaluateGate, mergeAuthority, type MergeAuthority } from "./merge-mode.ts";
import { checkAnswer, planAnswerMessage, preparePlan, readPlan, writePlan } from "./plan.ts";
import { readReport, REPORT_FILE } from "./report.ts";
import { planAsks, planOpen, type Plan } from "../../shared/plan.ts";
import { branchHead, branchState, diffStat, diffText, excludeWorktrees, gitBranch, gitHead, gitRoot, isMerged, removeThread, runSetup, THREAD_WORKTREES, type SetupOutcome } from "./thread.ts";
import { makeGroupId, makeHerdrName, makeId, type RunRegistry } from "./registry.ts";
import { abortableDelay, abortError, FleetError, isAbortError, type AgentRuntime } from "./runtime.ts";
import { THINKING_LEVELS, requireThinkingLevel, type AgentDefinition, type AgentKind, type AgentRun, type AgentState, type FleetConfig, type RoleOverride, type SkippedCandidate, type SpawnRequest, type ThinkingLevel, type ThreadSummary } from "./types.ts";
import type { ModelCatalog } from "./models.ts";
import type { FleetEvent } from "./events.ts";
import { Outbox, type Notice } from "./outbox.ts";
import { usageKey, type UsageTracker } from "./usage.ts";

/** One delegated turn, from the prompt until it settles. */
interface PendingTurn {
  armed: boolean;
  /** a blocked turn was already reported to waiters; reset when it works again */
  blockedReported: boolean;
  generation: number;
  /** when the prompt was handed to herdr; undefined until then, and for a turn a restart took over */
  submittedAt?: number;
  /** when a restarted server took over this turn, which it found running without knowing its submission */
  resumedAt?: number;
  /** herdr reported `working` for this turn at least once */
  sawWorking: boolean;
  /** what the fleet sent: a thread's next lead run hears it if this one fails; unknown for a turn a restart took over */
  text?: string;
}

/** the most of a result file a run keeps: a handoff, not a transcript */
export const RESULT_MAX_BYTES = 64 * 1024;
const RESULT_FILE = "handoff.md";
/** a thread lead's task as the thread was given it, beside its result file: a later run of the thread reads it */
const TASK_FILE = "task.md";

/** A spawn whose configured fallbacks (candidate entries) are still untried: consulted if its first turn fails. */
/** A spawn with its brief turned into the task and the paths it may write, ready to try candidates for. */
type PlannedSpawn = Omit<SpawnRequest, "brief" | "task"> & { group: string; task: string; write?: string[]; thread?: ThreadPlace };

/** Where a thread works (the repository its worktree comes from, or none outside one), and the run that owns it. */
interface ThreadPlace { repo: string | null; owner?: string; base?: string; baseBranch?: string; takeover?: Takeover }

/** A lead that takes a thread over from an earlier run of it: in that run's worktree and on its branch, with the thread's task. */
interface Takeover { from: AgentRun; thread: string; task?: string }

/** A thread to start: its lead gets the task, in a workspace (and worktree) of its own named by the title. */
export interface ThreadRequest {
  title: string;
  task?: string;
  brief?: Partial<Brief>;
  cwd?: string;
  /** the caller's depth: 0 for a person, the screen, or a top-level agent */
  depth?: number;
  /** the run that starts the thread (HERDR_FLEET_RUN), which then owns it: its results and questions go there */
  callerRun?: string;
}

const THREAD_ROLE = "lead";

/** The project's coordinator: started in the repository's main checkout, or the one already there. */
export interface ProjectRequest {
  task: string;
  cwd?: string;
  /** the herdr pane whose conversation sent the task through its CLI (the fleet skill), not the Fleet screen */
  fromPane?: string;
}


const PROJECT_ROLE = "coordinator";
/** the role whose ready report the merge gate takes as a review */
const REVIEWER_ROLE = "reviewer";
/** where a thread lead writes its acceptance contract: beside its result file (agents/lead.md) */
const CONTRACT_FILE = "contract.md";
interface SpawnPlan { request: PlannedSpawn; fallbacks: string[] }

/** the states in which a run may still be writing the paths its brief gave it */
const HOLDS_SCOPE: ReadonlySet<AgentState> = new Set(["starting", "working", "blocked", "unknown"]);

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
/** how long a project run without the person may stand still before its coordinator hears of it (superviseProjects) */
export const QUIET_MS = 15 * 60_000;
/** how soon the threads' questions are tried again while the person has a draft in the coordinator's input */
export const DRAFT_RETRY_MS = 5_000;
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
  /** the standing orders that apply in a folder (config.ts loadStandingOrders) */
  standingOrders?: (cwd: string) => string;
  /** the repository a folder lies in (thread.ts gitRoot); tests stand in their own */
  gitRoot?: (cwd: string) => Promise<string | null>;
  /** runs a project's setup command in a thread's fresh worktree (thread.ts runSetup) */
  runSetup?: (cwd: string, command: string, signal?: AbortSignal) => Promise<SetupOutcome>;
  /** keeps the threads' worktrees out of the repository's git status (thread.ts excludeWorktrees) */
  excludeWorktrees?: (repo: string) => Promise<void>;
  /** gitHead and diffStat; tests stand in for git */
  gitHead?: (cwd: string) => Promise<string | null>;
  diffStat?: typeof diffStat;
  /** the git and GitHub reads and changes that land a thread (thread.ts, github.ts); tests stand in for them */
  landing?: Partial<LandingTools>;
  /** the shell command an agent runs to reach the fleet (bin/fleet.ts) */
  fleetCommand: string;
  /** set in each agent's pane so its own fleet commands reach this server; read at each spawn */
  agentEnv: () => Record<string, string>;
  /** each run's result folder goes here, removed with the run's record */
  resultsDir: string;
  /**
   * each thread's plan, a file per run, written by the server only: apart from the result folders,
   * which agents may write. Beside `resultsDir` (fleet-plans) unless given.
   */
  plansDir?: string;
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
  /** DRAFT_RETRY_MS; tests shorten it */
  draftRetryMs?: number;
  /** QUIET_MS; tests shorten it */
  quietMs?: number;
  /** what each account has used: candidates without usage left are skipped, rate limits start cooldowns */
  usage?: Pick<UsageTracker, "unavailable" | "noteFailure" | "claimScreen" | "record">;
  /** refuses a model the CLI does not offer, before the run starts (models.ts) */
  models?: Pick<ModelCatalog, "unknown">;
  onChanged?: (run: AgentRun) => void;
  /** what happened, for the factory's metrics (events.ts) */
  events?: (event: FleetEvent) => void;
}

/** What landing a thread reads and changes in git and on GitHub, and what the merge gate reads (github.ts). */
export interface LandingTools {
  gitBranch: typeof gitBranch;
  branchState: typeof branchState;
  diffText: typeof diffText;
  branchHead: typeof branchHead;
  isMerged: typeof isMerged;
  removeThread: typeof removeThread;
  readPullRequest: typeof readPullRequest;
  compareOnGitHub: typeof compareOnGitHub;
  onGitHub: typeof onGitHub;
  headCommit: typeof headCommit;
  worktreeState: typeof worktreeState;
  mergeCommitOf: typeof mergeCommitOf;
  revertOf: typeof revertOf;
}

const LANDING_TOOLS: LandingTools = { gitBranch, branchState, diffText, branchHead, isMerged, removeThread, readPullRequest, compareOnGitHub, onGitHub, headCommit, worktreeState, mergeCommitOf, revertOf };

/** the landing steps a thread's lead takes on its branch; the coordinator takes the merges and the revert, and the fleet a discard */
const LEAD_STEPS: ReadonlySet<LandAction> = new Set(["update", "pr", "fix-ci", "comments"]);
const COORDINATOR_STEPS: ReadonlySet<LandAction> = new Set(["merge", "merge-pr", "revert"]);

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
  private readonly projectStarts = new Map<string, Promise<AgentRun>>();
  private readonly delivering = new Set<string>();
  /** per thread, its landing steps and restarts one at a time (onThread) */
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly draftRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly settleChecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly spawnPlans = new Map<string, SpawnPlan>();
  /** callers waiting for a run's turn to settle or block */
  private readonly waiters = new Map<string, Set<(run: AgentRun) => void>>();
  /** the concurrency check and the run's first save happen as one step */
  private spawnGate: Promise<void> = Promise.resolve();
  private stopped = false;
  /** per project coordinator: since when it and its threads stand still, and whether it heard of that */
  private readonly quietSince = new Map<string, number>();
  private readonly andonSent = new Set<string>();
  /** per thread: since when its lead is settled, and when GitHub was last asked about it */
  private readonly settledSince = new Map<string, number>();
  private readonly reconciledAt = new Map<string, number>();
  /** each run's state as last saved: a save that changes it is an event */
  private readonly savedStates = new Map<string, string>();
  /** threads whose merge gate is being evaluated now */
  private readonly gating = new Set<string>();
  /** threads whose merge step is being typed to the coordinator now */
  private readonly handing = new Set<string>();

  private readonly grace: number;
  private readonly quietMs: number;
  private readonly readyScreenMs: number;
  private readonly tools: LandingTools;
  /** the fleet's notices to its agents, kept until they went (outbox.ts) */
  private readonly outbox: Outbox;

  constructor(private readonly deps: OrchestratorDeps) {
    this.grace = deps.preVisualGraceMs ?? PRE_VISUAL_GRACE_MS;
    this.readyScreenMs = deps.readyScreenMs ?? READY_SCREEN_MS;
    this.quietMs = deps.quietMs ?? QUIET_MS;
    this.tools = { ...LANDING_TOOLS, ...deps.landing };
    this.pruneResults();
    // a restart read the runs back without their results: the result files hold them
    for (const run of deps.registry.all()) {
      run.result ??= readResult(this.resultFile(run));
      this.savedStates.set(run.id, run.state);
      // a turn still running when the last server stopped is read as it settles, like one this server
      // sent: herdr may not have shown it yet (the prompt was being pasted), or ended it while no
      // server listened and sends no event for it
      if (run.state === "working") {
        this.generations.set(run.id, 1);
        // what started it is not known here: a restart of its thread repeats no message
        this.pending.set(run.id, { armed: true, blockedReported: false, generation: 1, resumedAt: Date.now(), sawWorking: false, text: "" });
        this.armSettleCheck(run, 1);
      }
    }
    // a notice about a run the registry dropped refers to nothing its hearer can look up
    this.outbox = new Outbox(join(dirname(deps.resultsDir), "fleet-outbox.json"));
    this.outbox.prune((notice) => deps.registry.get(notice.about) !== undefined && !this.staleStep(notice));
    // runs saved before the outbox kept a thread's news on the run
    for (const run of deps.registry.all()) {
      if (run.notice === undefined) continue;
      this.queueNews(run, run.notice);
      delete run.notice;
      deps.registry.upsert(run);
    }
    // merge steps the person pressed that are neither sent nor queued (saved before the outbox, or the
    // server stopped between saving one and queuing it), in the order pressed. A delivered step is
    // marked sent before it leaves the outbox. The branch is the one the thread recorded: a
    // constructor cannot wait for git, and baseBranchOf falls back to main as well.
    const unsent = deps.registry.all().filter((run) => !run.replacedBy && run.landing && !run.landing.sent && !run.landing.error && COORDINATOR_STEPS.has(run.landing.action)
      && run.branch && !this.outbox.pending((notice) => notice.about === run.id && notice.slot === "landing").length);
    for (const run of unsent.sort((a, b) => a.landing!.at - b.landing!.at)) {
      // a merge the gate allowed goes back under its own header, and is read again before it goes
      this.outbox.put({ about: run.id, slot: "landing", section: run.landing!.by === "gate" ? "gate" : "steps", text: coordinatorStep(run as AgentRun & { branch: string }, run.baseBranch ?? "main"), landingAt: run.landing!.at });
    }
  }

  /** A result folder outlives its pane but not its run: once the registry dropped the run, it goes. So do undelivered instructions. */
  private pruneResults(): void {
    for (const dir of [this.deps.resultsDir, this.deps.instructionsDir, this.plansDir]) {
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) if (!this.deps.registry.get(name.replace(/\.(?:md|json)$/, ""))) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }

  private get plansDir(): string {
    return this.deps.plansDir ?? join(dirname(this.deps.resultsDir), "fleet-plans");
  }

  private planFile(run: AgentRun): string {
    return join(this.plansDir, `${run.id}.json`);
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

  private resultDir(run: AgentRun): string {
    return join(this.deps.resultsDir, run.id);
  }

  private resultFile(run: AgentRun): string {
    return join(this.resultDir(run), RESULT_FILE);
  }

  list(group?: string): AgentRun[] {
    return this.deps.registry.all().filter((run) => group === undefined || run.group === group).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The roles a spawn in `cwd` can name. */
  roles(cwd: string): AgentDefinition[] {
    return this.deps.agents(cwd);
  }

  /** A run of `group`, or a thread a run of `group` started: each thread is a fleet of its own, which its owner still reaches. */
  get(target: string, group?: string): AgentRun {
    const owned = (run: AgentRun | undefined) => run?.owner && this.deps.registry.get(run.owner)?.group === group ? run : undefined;
    let run = this.deps.registry.resolve(target, group) ?? (group === undefined ? undefined : owned(this.deps.registry.resolve(target)));
    if (!run) throw new FleetError("run_not_found", `Unknown fleet agent: ${target}`);
    // a thread outlives its lead runs: an earlier run's id reaches the lead that took it over
    for (let hops = 0; isThread(run) && run.replacedBy && hops < 32; hops++) {
      const next = this.deps.registry.get(run.replacedBy);
      if (!next) break;
      run = next;
    }
    return run;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.settleChecks.values()) clearTimeout(timer);
    this.settleChecks.clear();
    for (const timer of this.draftRetries.values()) clearTimeout(timer);
    this.draftRetries.clear();
  }

  // ---- spawn -------------------------------------------------------------------------------

  async spawn(request: SpawnRequest, signal?: AbortSignal): Promise<AgentRun> {
    return this.launch(request, signal);
  }

  /**
   * A thread: a fleet of its own, whose lead starts in a new workspace named by the title, on a
   * worktree of its own when the folder is a repository (after the user's setup command for it).
   * The lead stays when its turn ends, so the thread can be asked again.
   */
  async startThread(request: ThreadRequest, signal?: AbortSignal): Promise<AgentRun> {
    const title = request.title.trim();
    if (!title || title.length > 120) throw new FleetError("invalid_title", "A thread needs a title of up to 120 characters.");
    const cwd = resolve(request.cwd ?? process.cwd());
    const owner = request.callerRun ? this.deps.registry.get(request.callerRun) : undefined;
    if (request.callerRun && !owner) throw new FleetError("run_not_found", `Unknown calling run: ${request.callerRun}`);
    const repo = await (this.deps.gitRoot ?? gitRoot)(cwd);
    if (repo) await (this.deps.excludeWorktrees ?? excludeWorktrees)(repo);
    const base = repo ? await (this.deps.gitHead ?? gitHead)(repo) : null;
    const baseBranch = repo ? await this.tools.gitBranch(repo) : null;
    return this.launch({
      role: THREAD_ROLE, name: title, task: request.task, brief: request.brief, cwd, depth: request.depth,
      group: makeGroupId(), worktree: repo !== null, interactive: true,
    }, signal, { repo, ...(owner ? { owner: owner.id } : {}), ...(base ? { base } : {}), ...(baseBranch ? { baseBranch } : {}) });
  }

  /**
   * A project's coordinator: one per repository (or folder outside one), in a workspace of its own
   * at the main checkout. A second start of the same project hands the task to the live one.
   */
  async startProject(request: ProjectRequest, signal?: AbortSignal): Promise<AgentRun> {
    if (!request.task.trim()) throw new FleetError("missing_task", "task is required");
    const task = request.fromPane ? `${FROM_PANE}${request.fromPane}]\n\n${request.task}` : request.task;
    const cwd = resolve(request.cwd ?? process.cwd());
    const project = await (this.deps.gitRoot ?? gitRoot)(cwd) ?? cwd;
    // two starts of one project at once must not both find none and start two coordinators
    const previous = this.projectStarts.get(project) ?? Promise.resolve();
    const started = previous.catch(() => {}).then(async () => {
      const live = this.deps.registry.all().find((run) => run.role === PROJECT_ROLE && run.project === project && isLive(run));
      if (live) {
        this.deps.events?.({ kind: "person", run: live.id, project });
        return this.send(live.id, task, undefined, signal);
      }
      return this.launch({
        role: PROJECT_ROLE, name: `${basename(project)} · fleet`, task, cwd: project, depth: 0,
        group: makeGroupId(), worktree: false, interactive: true,
      }, signal, { repo: project });
    });
    this.projectStarts.set(project, started);
    try {
      return await started;
    } finally {
      if (this.projectStarts.get(project) === started) this.projectStarts.delete(project);
    }
  }

  /** The threads of the caller's project (the calling run's, or the repository `cwd` lies in), oldest first. */
  async threads(request: { callerRun?: string; cwd?: string }): Promise<ThreadSummary[]> {
    const caller = request.callerRun ? this.deps.registry.get(request.callerRun) : undefined;
    if (request.callerRun && !caller) throw new FleetError("run_not_found", `Unknown calling run: ${request.callerRun}`);
    const cwd = resolve(request.cwd ?? process.cwd());
    const project = caller?.project ?? await (this.deps.gitRoot ?? gitRoot)(cwd) ?? cwd;
    return this.list().filter((run) => run.role === THREAD_ROLE && run.project === project && !run.replacedBy).map((run) => {
      const contract = readResult(join(this.deps.resultsDir, run.id, CONTRACT_FILE));
      return { run, state: threadState(run), ...(run.outcome ? { status: outcomeLine(run.outcome) } : {}), ...(contract ? { contract: contractItems(contract) } : {}) };
    });
  }

  private async launch(request: SpawnRequest, signal?: AbortSignal, thread?: ThreadPlace): Promise<AgentRun> {
    const group = request.group ?? makeGroupId();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(group)) throw new FleetError("invalid_group", "group must be letters, digits, - and _ (up to 48)");
    const depth = request.depth ?? 0;
    const maxDepth = this.deps.config(resolve(request.cwd ?? process.cwd())).maxDepth;
    if (depth >= maxDepth) throw new FleetError("depth_limit", `Agent nesting limit reached: depth=${depth}, maxDepth=${maxDepth}`);
    // a person may say it in a line; an agent handing work on writes the brief its helper cannot ask back
    const { brief: given, ...rest } = request;
    const brief = given !== undefined || depth >= 1 ? checkBrief(given) : undefined;
    const task = brief ? renderBrief(brief, request.task) : request.task ?? "";
    if (!task.trim()) throw new FleetError("missing_task", "task is required");
    const write = brief && !request.worktree ? writeScope(resolve(request.cwd ?? process.cwd()), brief.write) : undefined;
    return this.spawnWithFallbacks({ ...rest, group, task, ...(write ? { write } : {}), ...(thread ? { thread } : {}) }, signal);
  }

  /**
   * The primary candidate, then each configured fallback in order. A candidate whose account has
   * no usage left or is cooling down is skipped; one that fails to start (the CLI quit with an
   * error before it was ready) moves on to the next, and a rate limit it quit on starts a cooldown.
   * Every other error is the caller's. `fallbacks` replaces the configured list for a re-spawn after
   * a failed first turn, so candidates already tried are not tried again.
   */
  private async spawnWithFallbacks(request: PlannedSpawn, signal?: AbortSignal, fallbacks?: string[], fallbackFrom?: string): Promise<AgentRun> {
    const cwd = resolve(request.cwd ?? process.cwd());
    const config = this.deps.config(cwd);
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
    const skipped: SkippedCandidate[] = [];
    let started = false;
    let outOfUsage = false;
    for (let i = 0; i < candidates.length; i++) {
      const entry = candidates[i];
      const { agent: kind, model } = parseCandidate(entry, roleKind);
      const last = i === candidates.length - 1;
      const avoided = request.avoid?.includes(kind) ? `the caller keeps ${kind} out`
        : definition.edits === false && !adapterFor(kind).readOnlyArgs ? `${kind} cannot be kept from editing files` : undefined;
      const refused = avoided ?? await this.deps.models?.unknown(kind, model);
      const unusable = refused ?? await this.deps.usage?.unavailable(kind, model, config.maxUsedPercent);
      if (unusable) {
        if (!refused) outOfUsage = true;
        failures.push(`${entry ?? "default"}: ${unusable}`);
        skipped.push({ candidate: entry ?? "default", reason: unusable });
        if (!last) continue;
        throw new FleetError(started ? "fallbacks_exhausted" : outOfUsage ? "usage_exhausted" : "no_candidates", `No candidate is usable: ${failures.join("; ")}`);
      }
      // a fallback is bounded by its own allow-list rather than refused: a person listed it
      const thinking = applyModelPolicy(config, model, baseThinking, i === 0 && explicitThinking !== undefined);
      try {
        started = true;
        return await this.spawnAttempt({ ...request, cwd }, config, definition, override, kind, model, thinking,
          candidates.slice(i + 1).filter((m): m is string => !!m), i === 0 ? fallbackFrom : candidates[i - 1] ?? fallbackFrom, [...skipped], signal);
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
        skipped.push({ candidate: entry ?? "default", reason });
      }
    }
    throw new FleetError("no_candidates", "No model candidates to spawn.");
  }

  private async spawnAttempt(request: PlannedSpawn & { cwd: string }, config: FleetConfig, definition: AgentDefinition, override: RoleOverride,
    kind: AgentKind, model: string | undefined, thinking: ThinkingLevel | undefined, fallbacks: string[], fallbackFrom: string | undefined, skipped: SkippedCandidate[], signal?: AbortSignal): Promise<AgentRun> {
    const adapter = adapterFor(kind);
    const depth = (request.depth ?? 0) + 1;
    const worktree = request.worktree ?? override.worktree ?? definition.worktree ?? false;
    const interactive = request.interactive ?? override.interactive ?? definition.interactive ?? false;
    // a child may spawn only when its role says so and its own children would still fit under maxDepth
    const canSpawn = (override.spawning ?? definition.spawning ?? false) && depth < config.maxDepth;
    const id = makeId();
    const herdrName = makeHerdrName(request.group, definition.name, id);
    const displayName = request.name?.trim() || definition.name;
    const takeover = request.thread?.takeover;
    // a lead that takes a thread over works on the thread's branch; a thread's first lead gets one of its own
    const branch = takeover ? takeover.from.branch : worktree && request.thread ? `fleet/${id}` : undefined;
    const env = { ...this.deps.agentEnv(), ...adapter.env?.({ resultDir: join(this.deps.resultsDir, id), fleetCommand: this.deps.fleetCommand, model, readOnly: definition.edits === false, merges: definition.name === PROJECT_ROLE }), HERDR_FLEET_GROUP: request.group, HERDR_FLEET_DEPTH: String(depth), HERDR_FLEET_RUN: id };

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
      // one writer per path: two agents changing the same files at once overwrite each other
      for (const holder of this.deps.registry.all()) {
        if (!request.write || !holder.write || !HOLDS_SCOPE.has(holder.state)) continue;
        const clash = overlap(request.write, holder.write);
        if (clash) throw new FleetError("scope_conflict", `${holder.name} (${holder.id}) is still changing ${clash.theirs}; wait for it, or give this task paths it does not hold.`);
      }
      const location = await this.deps.runtime.createLocation({
        cwd: request.cwd, label: displayName, worktree, branch: worktree ? (request.thread ? `fleet/${id}` : `agents/${definition.name}-${id}`) : undefined,
        ...(worktree && request.thread?.repo ? { path: join(request.thread.repo, THREAD_WORKTREES, id) } : {}),
        direction: request.direction, callerPaneId: request.callerPaneId, env,
      }, signal);
      const now = Date.now();
      run = {
        id, name: displayName, role: definition.name, agent: kind, group: request.group, herdrName, paneId: location.paneId, workspaceId: location.workspaceId,
        cwd: location.cwd, model, thinking, fallbackFrom, state: "starting", depth, interactive, worktree: takeover ? takeover.from.worktree : worktree, startedAt: now, updatedAt: now,
        ...(branch ? { branch } : {}),
        ...(request.thread?.repo ? { project: request.thread.repo } : {}), ...(request.thread?.owner ? { owner: request.thread.owner } : {}),
        ...(branch && request.thread?.base ? { base: request.thread.base } : {}),
        ...(branch && request.thread?.baseBranch ? { baseBranch: request.thread.baseBranch } : {}),
        ...(takeover ? carried(takeover, request.avoid) : {}),
        ...(skipped.length ? { skipped } : {}), ...(request.write ? { write: request.write } : {}),
        ...(definition.edits === false ? { readOnly: true as const } : {}),
      };
      if (definition.name === THREAD_ROLE && request.thread) run.writers = [...new Set([...(run.writers ?? []), kind])];
      // a helper that can edit writes in its thread; a reviewer counts once its turn saw the branch move (readTurn)
      else if (definition.edits !== false && definition.name !== REVIEWER_ROLE) this.noteWriter(request.group, kind);
      this.save(run);
    } finally {
      releaseGate();
    }

    // the agent writes each turn's handoff here: a folder of its own, outside any workspace
    const resultDir = join(this.deps.resultsDir, run.id);
    mkdirSync(this.deps.resultsDir, { recursive: true, mode: 0o700 });
    mkdirSync(resultDir, { mode: 0o700 });
    if (definition.name === THREAD_ROLE && request.thread) {
      const threadTask = takeover ? takeover.task : request.task;
      if (threadTask) writeFileSync(join(resultDir, TASK_FILE), threadTask, { mode: 0o600 });
      if (takeover) this.carryFiles(takeover.from, run);
    }
    // a project's coordinator talks with the person, who reads its reply: no agent reads a handoff of it
    const resultFile = definition.name === PROJECT_ROLE ? undefined : join(resultDir, RESULT_FILE);
    const standing = this.deps.standingOrders?.(request.cwd) ?? "";
    this.deps.events?.({ kind: "role", run: run.id, ...roleVersion(definition), ...(standing ? { standing: contentHash(standing) } : {}) });
    const merges = definition.name === THREAD_ROLE || definition.name === PROJECT_ROLE
      ? mergeRules(definition.name, run.project && run.baseBranch ? mergeAuthority(config.projects[run.project]?.merge, run.baseBranch) : { mode: "person" }, run.baseBranch)
      : undefined;
    const instructions = this.instructions(definition, displayName, request.group, canSpawn, resultFile, adapter, standing, config.language, merges);
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
      const setup = worktree && request.thread?.repo ? config.projects[request.thread.repo]?.setup : undefined;
      if (setup) await this.setUp(run, setup, signal);
      try {
        run.state = await this.deps.runtime.start({
          kind, name: herdrName, paneId: run.paneId, signal, startupError: (screen) => adapter.startupError(screen),
          args: [
            ...adapter.launchArgs({ model, thinking, tools: definition.tools, name: displayName, systemPromptFile: promptFile, systemPrompt: instructions, resultDir, cwd: run.cwd }),
            ...(definition.edits === false ? adapter.readOnlyArgs ?? [] : []),
          ],
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
   * What a lead that takes a thread over starts from: the run before's contract, as its own to bring
   * up to date (read as a result is, never through a symlink), and the thread's plan.
   */
  private carryFiles(from: AgentRun, to: AgentRun): void {
    const contract = readResult(join(this.resultDir(from), CONTRACT_FILE));
    if (contract) writeFileSync(join(this.resultDir(to), CONTRACT_FILE), `${contract}\n`, { mode: 0o600 });
    try { copyFileSync(this.planFile(from), this.planFile(to)); } catch { /* the thread has no plan */ }
  }

  /** The user's setup command in the thread's fresh worktree; a failure fails the run before its lead starts. */
  private async setUp(run: AgentRun, command: string, signal?: AbortSignal): Promise<void> {
    const outcome = await (this.deps.runSetup ?? runSetup)(run.cwd, command, signal);
    if (signal?.aborted) throw abortError(signal);
    if (outcome.ok) return;
    run.state = "failed";
    run.lastError = `The setup command \`${command}\` failed in ${run.cwd}:\n${outcome.output}`;
    run.updatedAt = Date.now();
    this.dropUndelivered(run);
    this.save(run);
    await this.deps.runtime.closePane(run.paneId).catch(() => undefined);
    throw new FleetError("setup_failed", run.lastError);
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

  private instructions(definition: AgentDefinition, name: string, group: string, canSpawn: boolean, resultFile: string | undefined, adapter: AgentAdapter, standing: string, language?: string, merges?: string): string {
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
        ? [
          `- Start a helper when splitting the work materially improves the result, with a brief it can work from without asking you: ${fleet} spawn --role <role> --goal "<the outcome, one sentence>" --write <path> (repeat; --read-only when it only reads) --context "<files, earlier results and decisions it needs, or none>" --done "<a checkable condition>" --verify "<commands to run, and the evidence to return>", then ${fleet} wait <id>.`,
          `  Each part has one executor: do not work on a part you handed on, or hand it to two agents. Two agents never write the same paths at once; the fleet refuses a spawn whose paths another working agent holds. Start a review only after the writer has finished, on another CLI than the writer's: add --avoid <cli> (${fleet} list shows each agent's CLI).`,
        ].join("\n")
        : "Do not start other agents.",
      "If an agent is blocked on an approval or a question, read its output and escalate to the human; never answer a blocked prompt yourself.",
      "Treat herdr's 'unknown' as uncertainty, not completion.",
      ...(adapter.note ? [adapter.note] : []),
      ...(definition.edits === false && adapter.readOnlyNote ? [adapter.readOnlyNote({ merges: definition.name === PROJECT_ROLE, fleetCommand: fleet })] : []),
      ...(resultFile ? [
        `Your result file is ${resultFile}.`,
        `Your report file is ${join(dirname(resultFile), REPORT_FILE)}.`,
        ...(definition.edits === false
          ? [adapter.readOnlyEditsResult
            ? "You edit no file but your result file and your report file: write them with your file-editing tool, which is limited to their folder."
            : "You edit no file, and your file-editing tools are off: write your result file and your report file with a shell command."]
          : []),
        "At the end of each turn, write your report file, replacing what it holds: one JSON object with \"state\": progress, waiting, ready, blocked, failed or dropped; \"summary\": one or two sentences; \"evidence\": a list of what you ran and what it showed; and \"human_action\": one concrete question for the person, only when the person must act.",
        "The states: progress, you are still at it and go on by yourself; waiting, your turn is done and you wait for a helper's result or a message; ready, the task is done and checked; blocked, you cannot go on without the person; failed, you tried and could not do it; dropped, there is nothing to do (it does not reproduce, or something else superseded it).",
        "The fleet takes your turn's outcome from your report file alone: a turn that ends without a valid one counts as no report, whatever your reply says.",
        "Also write a compact HANDOFF section to your result file, replacing what it holds, and end your reply with the same section: outcome, changed files, verification, unresolved questions. List every issue you can prove, not only the first.",
      ] : []),
      ...(merges ? ["", "## Merges", merges] : []),
      ...(language ? [
        "",
        "## The person's language",
        `The person reads ${language}. Write in ${language} what the person reads: your replies to the person, a plan, a question for the person, a thread lead's HANDOFF and contract, and pull request titles and bodies. Write tasks and messages for other agents in English. Keep code, commands, paths, identifiers, quoted output and the status word PASS, ISSUES or BLOCKED as they are. Commit messages and code comments follow the repository's own conventions.`,
      ] : []),
      ...(standing ? ["", "## Standing orders", "The person who runs this fleet gives these to every agent. Follow them in every turn. Every agent of the fleet gets them, so a task you hand on need not repeat them.", standing] : []),
    ].join("\n");
  }

  // ---- turns -------------------------------------------------------------------------------

  async send(target: string, message: string, group?: string, signal?: AbortSignal): Promise<AgentRun> {
    const asked = this.get(target, group);
    // a settlement still being handled (the fleet may be reading the usage in the pane, or starting a
    // thread's next lead run) finishes first; the run it leaves to talk to is read after it
    await this.reconcileLocks.get(asked.id);
    const run = this.get(asked.id, group);
    if (!isLive(run)) throw new FleetError("run_ended", `${run.name} has ${run.state}; start a new agent instead.`);
    return this.submit(run, message, signal);
  }

  /** Marks a thread done for the person, or open again; its lead's next turn opens it again too. */
  resolve(target: string, resolved: boolean, group?: string): AgentRun {
    const run = this.get(target, group);
    if (!isThread(run)) throw new FleetError("not_a_thread", `${run.name} is not a thread's lead.`);
    if (resolved) run.resolvedAt = Date.now();
    else delete run.resolvedAt;
    run.updatedAt = Date.now();
    this.save(run);
    return { ...run };
  }

  // ---- landing a thread ----------------------------------------------------------------------

  /** A thread on a branch of its own, still there to land: the landing steps' target. */
  private landable(target: string, group?: string): AgentRun & { project: string; branch: string } {
    const run = this.get(target, group);
    if (!isThread(run) || !run.branch) throw new FleetError("not_a_thread", `${run.name} is not a thread on a branch of its own.`);
    return run as AgentRun & { project: string; branch: string };
  }

  private baseBranchOf(run: AgentRun & { project: string }): Promise<string> {
    return run.baseBranch ? Promise.resolve(run.baseBranch) : this.tools.gitBranch(run.project).then((branch) => branch ?? "main");
  }

  /** What stands between a thread and landing: its uncommitted work, its branch beside the base, its pull request, read now. */
  async checks(target: string, group?: string): Promise<LandingChecks> {
    const run = this.landable(target, group);
    const baseBranch = await this.baseBranchOf(run);
    const branch = run.landed ? null : await this.tools.branchState(run.cwd, baseBranch);
    const checks: LandingChecks = { baseBranch, uncommitted: branch?.uncommitted ?? [], ahead: branch?.ahead ?? 0, behind: branch?.behind ?? 0 };
    try {
      const reading = await this.readPullRequest(run);
      if (reading) checks.pr = pullRequest(reading);
    } catch (error) {
      checks.prError = error instanceof Error ? error.message : String(error);
      if (run.pr) checks.pr = run.pr;
    }
    return checks;
  }

  /** A thread's change since it left its base branch, as a unified diff. */
  async diff(target: string, group?: string): Promise<{ diff: string; truncated: boolean }> {
    const run = this.landable(target, group);
    const diff = run.landed ? null : await this.tools.diffText(run.cwd, await this.baseBranchOf(run));
    if (!diff) throw new FleetError("diff_unavailable", `git could not show the change of ${run.name}.`);
    return diff;
  }

  /**
   * A landing step the person pressed. The lead takes the steps on its branch at once (it must be
   * free), the project's coordinator the merges once it is free (a new one starts when none lives),
   * and a discard happens here. Each message names the step the person approved, and only that one.
   * When the agent's turn ends, the fleet reads git and GitHub for whether the step happened.
   */
  async land(target: string, action: LandAction, options: { comments?: LineComment[] } = {}, group?: string, signal?: AbortSignal): Promise<AgentRun> {
    const asked = this.landable(target, group);
    // a settlement still being handled finishes first: it may start the thread again on a new lead
    await this.reconcileLocks.get(asked.id);
    const { run, coordinator } = await this.onThread(threadId(asked), () => this.landStep(asked.id, action, options, group, signal));
    if (!coordinator) return run;
    await this.deliverNotices(coordinator);
    return { ...this.get(run.id) };
  }

  /**
   * The step on the thread's lead as the thread's lock found it, before or after a restart and never
   * during one; a merge step comes back with the coordinator to tell once the lock is free.
   */
  private async landStep(id: string, action: LandAction, options: { comments?: LineComment[] }, group?: string, signal?: AbortSignal): Promise<{ run: AgentRun; coordinator?: AgentRun }> {
    const run = this.landable(id, group);
    if (action === "revert") {
      if (run.landed !== "merged" || !run.merged?.commit) throw new FleetError("not_merged", `${run.name} has no merge the fleet knows the commit of.`);
      if (run.reverted) throw new FleetError("thread_reverted", `The merge of ${run.name} was already reverted.`);
    } else if (run.landed) throw new FleetError("thread_landed", `${run.name} was already ${run.landed}.`);
    if (action === "discard") {
      await this.closeThread(run, "discarded");
      return { run: { ...run } };
    }
    const handler = LEAD_STEPS.has(action) ? run : this.projectCoordinator(run);
    if (run.landing && !run.landing.error && run.landing.sent && handler && isLive(handler) && this.pending.has(handler.id)) {
      throw new FleetError("landing_busy", `${run.name} is still on ${run.landing.action}; wait for it to end.`);
    }
    const baseBranch = await this.baseBranchOf(run);
    if (action === "merge-pr" && run.pr?.state !== "OPEN") throw new FleetError("no_pull_request", `${run.name} has no open pull request.`);
    if (action === "fix-ci" && !run.pr) throw new FleetError("no_pull_request", `${run.name} has no pull request.`);
    if (action === "comments" && !options.comments?.length) throw new FleetError("missing_comments", "comments are required");
    if (LEAD_STEPS.has(action)) {
      if (!isLive(run)) throw new FleetError("run_ended", `The lead of ${run.name} has ${run.state}.`);
      if (this.pending.has(run.id)) throw new FleetError("run_busy", `The lead of ${run.name} is working; wait for its turn to end.`);
      run.landing = { action, at: Date.now(), sent: true };
      this.save(run);
      return { run: await this.notifyNow(run, leadStep(run, action, baseBranch, options.comments ?? []), signal) };
    }
    run.landing = { action, at: Date.now(), sent: false };
    this.save(run);
    const coordinator = this.projectCoordinator(run);
    if (coordinator) {
      this.outbox.put({ about: run.id, slot: "landing", section: "steps", text: coordinatorStep(run, baseBranch), landingAt: run.landing.at });
      return { run, coordinator };
    }
    // no coordinator lives: a new one starts with the step as its first task
    run.landing.sent = true;
    this.save(run);
    try {
      await this.startProject({ task: [STEPS_HEADER, `- ${coordinatorStep(run, baseBranch)}`].join("\n"), cwd: run.project }, signal);
    } catch (error) {
      run.landing = { ...run.landing, error: `No coordinator could start for the ${action === "revert" ? "revert" : "merge"}: ${error instanceof Error ? error.message : String(error)}` };
      this.save(run);
      throw error;
    }
    return { run: { ...this.get(run.id) } };
  }

  /** `work` once the thread's landing steps and restarts before it ended, and before the ones after it */
  private onThread<T>(thread: string, work: () => Promise<T>): Promise<T> {
    const result = (this.threadLocks.get(thread) ?? Promise.resolve()).then(work);
    const settled = result.then(() => undefined, () => undefined);
    this.threadLocks.set(thread, settled);
    void settled.then(() => { if (this.threadLocks.get(thread) === settled) this.threadLocks.delete(thread); });
    return result;
  }

  /**
   * A merge the gate allowed, queued for the project's coordinator under its own header. It waits,
   * unsent, for a coordinator to be free (the fleet starts none for it), and is read again then.
   */
  private async handGateMerge(run: AgentRun & { project: string; branch: string }, baseBranch: string): Promise<void> {
    this.outbox.put({ about: run.id, slot: "landing", section: "gate", text: coordinatorStep(run, baseBranch), landingAt: run.landing!.at });
    const coordinator = this.projectCoordinator(run);
    if (coordinator) await this.deliverNotices(coordinator);
  }

  // ---- a thread's plan -------------------------------------------------------------------------

  /** A thread's lead, which alone writes a plan for the person. */
  private planner(target: string, group?: string): AgentRun & { project: string } {
    const run = this.get(target, group);
    if (!isThread(run)) throw new FleetError("not_a_thread", `${run.name} is not a thread's lead; only a thread's lead writes a plan.`);
    return run as AgentRun & { project: string };
  }

  /**
   * The plan a thread's lead hands over (`fleet plan`): checked, its code read from the thread's
   * worktree, and kept in the fleet's plans folder in place of the one before. The thread then
   * waits on the person until they answer it on the Fleet screen.
   */
  submitPlan(target: string, value: unknown, group?: string): Plan {
    const run = this.planner(target, group);
    const file = this.planFile(run);
    let previous: number;
    // a kept plan that cannot be read back still counted a version
    try { previous = readPlan(file)?.version ?? 0; } catch { previous = run.plan?.version ?? 0; }
    const plan = preparePlan(value, run.cwd, previous + 1);
    writePlan(file, plan);
    run.plan = { version: plan.version, asks: planAsks(plan).length };
    run.updatedAt = Date.now();
    this.save(run);
    return plan;
  }

  /** The thread's plan as its lead last handed it over. */
  plan(target: string, group?: string): Plan {
    const run = this.planner(target, group);
    const plan = readPlan(this.planFile(run));
    if (!plan) throw new FleetError("no_plan", `${run.name} has written no plan.`);
    return plan;
  }

  /**
   * The person's answers to the plan, sent to the lead as its next task. The lead must be free: its
   * turn ended, as for the landing steps it takes. An answer to an older version is refused.
   */
  async answerPlan(target: string, value: unknown, group?: string, signal?: AbortSignal): Promise<AgentRun> {
    const run = this.planner(target, group);
    const file = this.planFile(run);
    const plan = this.plan(run.id);
    const answer = checkAnswer(plan, value);
    if (plan.answeredAt !== undefined) throw new FleetError("plan_answered", `The person already answered version ${plan.version} of the plan of ${run.name}.`);
    if (plan.closedAt !== undefined) throw new FleetError("plan_closed", `The lead of ${run.name} went on without answers to version ${plan.version} of its plan.`);
    if (!isLive(run)) throw new FleetError("run_ended", `The lead of ${run.name} has ${run.state}.`);
    await this.reconcileLocks.get(run.id);
    if (run.replacedBy) throw replaced(run);
    if (!isLive(run)) throw new FleetError("run_ended", `The lead of ${run.name} has ${run.state}.`);
    if (this.pending.has(run.id)) throw new FleetError("run_busy", `The lead of ${run.name} is working; wait for its turn to end.`);
    // the turn is under way before anything awaits again, so a second answer finds the lead busy;
    // the plan counts as answered once the message reached the lead
    const sent = await this.notifyNow(run, planAnswerMessage(plan, answer), signal);
    // submit answers a refusal without throwing: herdr would not type into a lead on its approval
    // screen, or the prompt failed. The answers did not arrive, so the plan still takes them.
    // (a prompt typed that left the lead on an approval screen did arrive: its turn is pending)
    if (sent.state === "failed" || (sent.state === "blocked" && !this.pending.has(run.id))) {
      if (sent.state === "blocked") throw new FleetError("agent_blocked", `The lead of ${run.name} is waiting on its screen (an approval or a question); answer it there, then send your answers again.`);
      throw new FleetError("answer_not_delivered", `The answers did not reach the lead of ${run.name}: ${sent.lastError ?? "its pane refused them"}.`);
    }
    // the question the coordinator was still to hear was this plan: the person answered it
    this.outbox.drop(run.id, "news");
    // the lead may have handed over a newer plan meanwhile: only the version answered is marked
    let current: Plan | undefined;
    try { current = readPlan(file); } catch { current = undefined; }
    if (current?.version !== plan.version) return { ...run };
    const answeredAt = Date.now();
    writePlan(file, { ...current, answeredAt, answer });
    run.plan = { version: plan.version, asks: planAsks(current).length, answeredAt };
    this.save(run);
    return { ...run };
  }

  /**
   * A turn of the lead settled after the one that wrote its plan, without the person's answers
   * (someone sent it another task, or decided in its chat): the lead went on, and the plan, no
   * longer what it builds to, takes no answers.
   */
  private closeStalePlan(run: AgentRun, turn: PendingTurn): void {
    if (!run.plan || !planOpen(run.plan) || turn.submittedAt === undefined) return;
    const file = this.planFile(run);
    let plan: Plan | undefined;
    try { plan = readPlan(file); } catch { return; }
    if (!plan || plan.version !== run.plan.version || plan.writtenAt >= turn.submittedAt) return;
    const closedAt = Date.now();
    writePlan(file, { ...plan, closedAt });
    run.plan = { ...run.plan, closedAt };
  }

  /** The project's live coordinator: the merges happen in the main checkout it sits on. */
  private projectCoordinator(thread: AgentRun): AgentRun | undefined {
    return this.deps.registry.all().find((run) => run.role === PROJECT_ROLE && run.project === thread.project && isLive(run));
  }

  /** The thread's pull request on GitHub now, kept on its run; null when its branch has none. */
  private async readPullRequest(run: AgentRun & { project?: string; branch?: string }): Promise<PullRequestReading | null> {
    if (!run.project || !run.branch) return null;
    const reading = await this.tools.readPullRequest(run.project, run.branch);
    const pr = reading ? pullRequest(reading) : undefined;
    if (JSON.stringify(pr) !== JSON.stringify(run.pr)) {
      run.pr = pr;
      run.updatedAt = Date.now();
      this.save(run);
    }
    return reading;
  }

  /** The lead's turn after a landing step ended: whether the step happened, as git and GitHub say. */
  private async settleLeadStep(run: AgentRun): Promise<void> {
    const step = run.landing!;
    const thread = run as AgentRun & { project: string; branch: string };
    let error: string | undefined;
    try {
      if (step.action === "pr") {
        const pr = await this.readPullRequest(thread);
        if (pr?.state !== "OPEN") error = `The lead's turn ended without an open pull request for ${thread.branch}.`;
      } else {
        if (run.pr?.state === "OPEN") await this.readPullRequest(thread);
        if (step.action === "update") {
          const baseBranch = await this.baseBranchOf(thread);
          const state = await this.tools.branchState(run.cwd, baseBranch);
          if (state && state.behind > 0) error = `${thread.branch} is still ${state.behind} commit${state.behind === 1 ? "" : "s"} behind ${baseBranch}.`;
        }
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (error) run.landing = { ...step, error };
    else delete run.landing;
  }

  /** The coordinator's turn ended: the merges it was handed, checked in git and on GitHub, and the threads that landed closed. */
  private async settleMerges(coordinator: AgentRun): Promise<void> {
    const handed = this.deps.registry.all().filter((run) => !run.replacedBy && run.landing?.sent && !run.landing.error && COORDINATOR_STEPS.has(run.landing.action)
      && this.projectCoordinator(run)?.id === coordinator.id);
    // a restart of the thread under way finishes first: its new lead holds the step then
    for (const run of handed) {
      const step = run.landing;
      if (!step) continue;
      await this.onLead(run, (thread) => this.settleMerge(thread, step), step.action === "revert");
    }
  }

  /** A step handed to the coordinator, settled on the thread's lead while it still holds that step. */
  private async settleMerge(thread: AgentRun & { project: string; branch: string }, handed: LandingStep): Promise<void> {
    const step = thread.landing;
    if (!step?.sent || step.error || step.action !== handed.action || step.at !== handed.at) return;
    try {
      if (step.action === "revert") {
        const merged = thread.merged!;
        const baseBranch = merged.base ?? await this.baseBranchOf(thread);
        const merge = merged.commit!;
        const revert = await this.tools.revertOf(thread.project, baseBranch, merge);
        // a pull request's merge is undone only once the revert is on GitHub's base branch too
        const pushed = revert && merged.via === "pr" ? await this.tools.onGitHub(thread.project, baseBranch, revert) : true;
        if (revert && !pushed) thread.landing = { ...step, error: `The revert ${revert.slice(0, 12)} is on ${baseBranch} here, but GitHub's ${baseBranch} does not have it: the push did not happen.` };
        else if (revert) {
          thread.reverted = { at: Date.now(), commit: revert };
          delete thread.landing;
          this.deps.events?.({ kind: "revert", run: thread.id, project: thread.project, base: baseBranch, commit: merge, revert });
        } else thread.landing = { ...step, error: `${baseBranch} has no commit that reverts ${merge.slice(0, 12)} after the coordinator's turn; its reply says why.` };
      } else if (step.action === "merge") {
        const baseBranch = await this.baseBranchOf(thread);
        if (await this.tools.isMerged(thread.project, thread.branch, baseBranch)) {
          const head = await this.tools.branchHead(thread.project, thread.branch);
          this.recordMerge(thread, "person", "local", baseBranch, head ? await this.tools.mergeCommitOf(thread.project, head, baseBranch) : null);
          await this.closeThread(thread, "merged");
        } else thread.landing = { ...step, error: `${thread.branch} is not in ${baseBranch} after the coordinator's turn; its reply says why.` };
      } else {
        const reading = await this.readPullRequest(thread);
        if (reading?.state === "MERGED") await this.mergedOnGitHub(thread, reading, step.by === "gate" ? "gate" : "person");
        else thread.landing = { ...step, error: `Pull request #${thread.pr?.number ?? "?"} is not merged after the coordinator's turn; its reply says why.` };
      }
    } catch (failure) {
      thread.landing = { ...step, error: failure instanceof Error ? failure.message : String(failure) };
    }
    thread.updatedAt = Date.now();
    this.save(thread);
  }

  /**
   * `work` on the thread `run` belongs to, under its lock (onThread) and with its lead as the lock
   * found it: a restart before it may have handed the thread to a new run, which the run before must
   * not close. A thread that closed meanwhile is left alone, unless the work is for a closed thread
   * (`landed`: the Revert of its merge).
   */
  private onLead<T>(run: AgentRun, work: (lead: AgentRun & { project: string; branch: string }) => Promise<T>, landed = false): Promise<T | undefined> {
    return this.onThread(threadId(run), async () => {
      const lead = this.get(run.id) as AgentRun & { project: string; branch: string };
      return lead.landed && !landed ? undefined : work(lead);
    });
  }

  /**
   * A thread whose pull request GitHub merged: recorded, closed, its branch deleted when GitHub merged
   * the commit it is at here. `by` is who merged it: a merge none of the fleet's steps asked for is
   * someone else's on GitHub (the person there, or an agent that should not have).
   */
  private async mergedOnGitHub(thread: AgentRun & { project: string; branch: string }, reading: PullRequestReading, by: MergeBy = this.handedMerge(thread) ?? "github"): Promise<void> {
    this.recordMerge(thread, by, "pr", reading.base ?? await this.baseBranchOf(thread), reading.mergeCommit ?? null);
    const local = await this.tools.branchHead(thread.project, thread.branch);
    await this.closeThread(thread, "merged", local !== null && reading.head === local);
  }

  /**
   * Who a merge the coordinator was handed (or is being typed) and has not settled yet is by: the
   * polling may see it on GitHub first.
   */
  private handedMerge(run: AgentRun): MergeBy | undefined {
    const step = run.landing;
    if (!step || step.error || step.action !== "merge-pr" || (!step.sent && !this.handing.has(run.id))) return undefined;
    return step.by === "gate" ? "gate" : "person";
  }

  /** A thread's merge, kept on its run (the Revert step needs its commit) and in the event log, once. */
  private recordMerge(thread: AgentRun & { project: string }, by: MergeBy, via: "pr" | "local", base: string, commit: string | null): void {
    if (thread.merged) return;
    thread.merged = { by, via, base, at: Date.now(), ...(commit ? { commit } : {}) };
    const lines = thread.diff;
    this.deps.events?.({
      kind: "merge", run: thread.id, project: thread.project, base, by,
      ...(thread.pr ? { pr: thread.pr.number } : {}), ...(commit ? { commit } : {}), ...(lines ? { lines: lines.added + lines.removed } : {}),
    });
  }

  /**
   * The open pull requests, read again: their checks, and whether the person merged or closed one
   * on GitHub. A merged one closes its thread once its lead is not at work (else as its turn ends);
   * checks that came to pass let the merge gate look at it again. The server calls this from time
   * to time; it asks GitHub nothing while no thread has an open pull request.
   */
  async refreshPullRequests(): Promise<void> {
    for (const run of this.list().filter((each) => isThread(each) && each.pr?.state === "OPEN" && !each.landed && !each.replacedBy)) {
      const thread = run as AgentRun & { project: string; branch: string };
      try {
        const before = run.pr?.checks;
        const reading = await this.readPullRequest(thread);
        if (reading?.state === "MERGED") {
          await this.onLead(thread, async (lead) => {
            if (!this.pending.has(lead.id) && lead.state !== "working") await this.mergedOnGitHub(lead, reading);
          });
        } else if (reading?.state === "OPEN" && reading.checks !== before && (reading.checks === "pass" || reading.checks === "none")) {
          await this.onLead(thread, async (lead) => {
            if (!this.pending.has(lead.id) && lead.state !== "working") await this.considerGate(lead);
          });
        }
      } catch {
        // GitHub could not be asked: the reading kept stands until the next try
      }
    }
  }

  /**
   * The projects run without the person, looked after (the server calls this after
   * refreshPullRequests). Two things only the person noticed before:
   * - the fleet's records against GitHub: a thread whose pull request GitHub shows merged, while its
   *   lead stayed settled through the quiet period, is closed and its coordinator told (a merge seen
   *   at once may come from a lead that broke off its turn to wait, and goes on after it);
   * - a standstill: when the coordinator and every run of its threads stayed settled through the
   *   quiet period, the coordinator hears of it once, with where each thread stands. It hears again
   *   only after a thread moved: its own answer is no reason, so a project where everything left is
   *   blocked or done is not called on and on.
   * It asks GitHub nothing about a thread more often than once per quiet period, and writes nothing.
   */
  async superviseProjects(): Promise<void> {
    const now = Date.now();
    for (const coordinator of this.list().filter((run) => run.role === PROJECT_ROLE && run.project && isLive(run))) {
      if (!this.deps.config(coordinator.cwd).autonomous) continue;
      const threads = this.list().filter((run) => isThread(run) && run.project === coordinator.project && isLive(run) && !run.landed);
      for (const thread of threads) await this.reconcileThread(thread as AgentRun & { project: string; branch: string }, now);
      const open = threads.filter((run) => isLive(run) && !run.landed);
      const groups = new Set([coordinator.group, ...open.map((run) => run.group)]);
      const members = this.list().filter((run) => groups.has(run.group) && isLive(run));
      const moving = (run: AgentRun) => this.pending.has(run.id) || run.state === "working" || run.state === "starting";
      if (members.some((run) => run.id !== coordinator.id && moving(run))) this.andonSent.delete(coordinator.id);
      if (members.some(moving)) { this.quietSince.set(coordinator.id, now); continue; }
      const since = this.quietSince.get(coordinator.id);
      if (since === undefined) { this.quietSince.set(coordinator.id, now); continue; }
      if (now - since < this.quietMs || this.andonSent.has(coordinator.id)) continue;
      if (await this.callStandstill(coordinator, open, now - since)) {
        this.andonSent.add(coordinator.id);
        this.deps.events?.({ kind: "standstill", run: coordinator.id, project: coordinator.project!, quietMs: now - since });
      }
    }
  }

  /** A settled thread's pull request, read once per quiet period: merged on GitHub, the thread closes. */
  private async reconcileThread(thread: AgentRun & { project: string; branch: string }, now: number): Promise<void> {
    if (this.pending.has(thread.id) || thread.state === "working" || thread.state === "starting") {
      this.settledSince.delete(thread.id);
      return;
    }
    const since = this.settledSince.get(thread.id);
    if (since === undefined) { this.settledSince.set(thread.id, now); return; }
    if (now - since < this.quietMs || now - (this.reconciledAt.get(thread.id) ?? 0) < this.quietMs) return;
    this.reconciledAt.set(thread.id, now);
    try {
      const reading = await this.readPullRequest(thread);
      if (reading?.state !== "MERGED") return;
      const closed = await this.onLead(thread, async (lead) => {
        if (this.pending.has(lead.id) || lead.state === "working" || lead.state === "starting") return undefined;
        await this.mergedOnGitHub(lead, reading);
        return lead;
      });
      if (!closed) return;
      this.deps.events?.({ kind: "reconciled", run: closed.id, project: closed.project, ...(closed.pr ? { pr: closed.pr.number } : {}) });
      this.queueNews(closed, threadClosedAfterMerge(closed, now - since));
      void this.tellCoordinator(closed);
    } catch {
      // GitHub could not be asked: the next quiet period asks again
    }
  }

  /** The coordinator, free, hears that its project stands still; false when it could not be told now. */
  private callStandstill(coordinator: AgentRun, threads: AgentRun[], quietFor: number): Promise<boolean> {
    return this.tellWhenFree(coordinator, standstill(threads, quietFor));
  }

  /** `text` to the coordinator when it is free (no turn in flight, settled, no draft of the person's); false when it is not. */
  private async tellWhenFree(coordinator: AgentRun, text: string): Promise<boolean> {
    if (this.delivering.has(coordinator.id)) return false;
    await this.reconcileLocks.get(coordinator.id);
    const live = await this.liveState(coordinator);
    if (!live || !isCompleted(live) || this.pending.has(coordinator.id) || await this.hasDraft(coordinator)) return false;
    return this.typed(coordinator, await this.notifyNow(coordinator, text));
  }

  /**
   * A thread that landed or was thrown away: its agents' panes close, its worktree and branch go
   * (a discard forces both), and it is resolved. What git kept is said on the thread.
   */
  private async closeThread(thread: AgentRun & { project: string; branch: string }, how: "merged" | "discarded", branchMerged = false): Promise<void> {
    for (const member of this.list().filter((run) => run.group === thread.group && isLive(run))) {
      await this.deps.runtime.closePane(member.paneId).catch(() => undefined);
      member.state = "stopped";
      member.updatedAt = Date.now();
      this.dropPending(member.id);
      this.save(member);
      this.settleWaiters(member);
    }
    const kept = await this.tools.removeThread(thread.project, join(thread.project, THREAD_WORKTREES, threadId(thread)), thread.branch, { force: how === "discarded", branchMerged });
    thread.landed = how;
    thread.resolvedAt = Date.now();
    if (kept) thread.landing = { action: how === "discarded" ? "discard" : thread.landing?.action ?? "merge", at: Date.now(), sent: true, error: kept };
    else delete thread.landing;
    thread.updatedAt = Date.now();
    this.save(thread);
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
    const pending: PendingTurn = { armed: false, blockedReported: false, generation, sawWorking: false, text };
    this.pending.set(run.id, pending);
    this.clearTurnFiles(run);
    if (run.role === REVIEWER_ROLE) await this.openReview(run);
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
      // a turn fast enough to settle before the TUI ever flips may send no further event
      if (submitted !== "working") this.armSettleCheck(run, generation);
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

  /** A turn starts: a result file and a report found when it settles are this turn's. */
  private clearTurnFiles(run: AgentRun): void {
    rmSync(this.resultFile(run), { force: true });
    rmSync(join(this.resultDir(run), REPORT_FILE), { force: true });
  }

  // ---- the threads' questions, for their project's coordinator -------------------------------

  /** Who hears a thread's questions: the run that started it while it lives, else the project's live coordinator. */
  private coordinatorOf(thread: AgentRun): AgentRun | undefined {
    const owner = thread.owner ? this.deps.registry.get(thread.owner) : undefined;
    if (owner && isLive(owner)) return owner;
    return this.deps.registry.all().find((run) => run.role === PROJECT_ROLE && run.project === thread.project && isLive(run));
  }

  private async tellCoordinator(thread: AgentRun): Promise<void> {
    const coordinator = this.coordinatorOf(thread);
    if (coordinator) await this.deliverNotices(coordinator);
  }

  /** A thread's news for whoever hears it, kept until it went; none takes back the news not yet sent. */
  private queueNews(thread: AgentRun, text: string | undefined): void {
    if (text) this.outbox.put({ about: thread.id, slot: "news", section: "news", text });
    else this.outbox.drop(thread.id, "news");
  }

  /** Who hears a queued notice now: a merge step the project's coordinator, news whoever hears the thread. */
  private hearerOf(notice: Notice): AgentRun | undefined {
    const about = this.deps.registry.get(notice.about);
    if (!about) return undefined;
    // a merge goes to the coordinator on the main checkout, whoever started the thread
    return notice.section === "steps" || notice.section === "gate" ? this.projectCoordinator(about) : this.coordinatorOf(about);
  }

  /** a merge step the thread no longer waits on: another step, a discard or a close took its place */
  private staleStep(notice: Notice): boolean {
    if (notice.landingAt === undefined) return false;
    const landing = this.deps.registry.get(notice.about)?.landing;
    return landing?.at !== notice.landingAt || landing.sent === true || landing.error !== undefined;
  }

  /** `text` to `run` now, written to the outbox before it is typed: the run as submit left it. */
  private async notifyNow(run: AgentRun, text: string, signal?: AbortSignal): Promise<AgentRun> {
    let sent: AgentRun = { ...run };
    await this.outbox.sendNow(run.id, text, async (each) => this.typed(run, sent = await this.submit(run, each, signal)));
    return sent;
  }

  /** the text reached the run: its turn runs, or waits on an approval screen the text brought up */
  private typed(run: AgentRun, sent: AgentRun): boolean {
    return sent.state === "working" || (sent.state === "blocked" && this.pending.has(run.id));
  }

  /**
   * Every thread's question waiting for `coordinator`, in one message, once it is free: no turn of the
   * fleet's in flight, herdr calls it settled (a person's turn shows as working), and no draft of the
   * person's in its input. A coordinator that is not free hears them when it settles, or a little
   * later when the person left a draft; one that ended leaves them to the next.
   */
  private async deliverNotices(coordinator: AgentRun): Promise<void> {
    if (this.delivering.has(coordinator.id)) return;
    this.delivering.add(coordinator.id);
    try {
      const due = () => {
        this.outbox.prune((notice) => !this.staleStep(notice));
        return this.outbox.pending((notice) => this.hearerOf(notice)?.id === coordinator.id);
      };
      if (!due().length || this.pending.has(coordinator.id) || !isLive(coordinator)) return;
      await this.reconcileLocks.get(coordinator.id);
      const live = await this.liveState(coordinator);
      if (!live || !isCompleted(live) || this.pending.has(coordinator.id)) return;
      if (await this.hasDraft(coordinator)) return this.retryNotices(coordinator);
      // a merge the gate allowed goes out only while the gate still holds for the same pull request and commit
      // (one withdrawn carries an error now, and due() prunes its notice as stale)
      for (const notice of due().filter((each) => each.section === "gate")) {
        const run = this.deps.registry.get(notice.about);
        if (!run || run.landing?.at !== notice.landingAt) continue;
        await this.gateStillHolds(run);
      }
      // read again after the waits: the person may have thrown a thread away meanwhile. One merge the
      // gate allowed at a time, and never beside a merge the person pressed, which would move the base
      // it was read against: the next is read again once the coordinator is free
      const all = due();
      const pressed = all.filter((notice) => notice.section === "steps");
      const gated = pressed.length ? [] : all.filter((notice) => notice.section === "gate").slice(0, 1);
      const notices = all.filter((notice) => notice.section !== "gate" || gated.includes(notice));
      if (!notices.length || this.pending.has(coordinator.id)) return;
      const headers = { news: this.deps.config(coordinator.cwd).autonomous ? NEWS_HEADER : QUESTIONS_HEADER, steps: STEPS_HEADER, gate: GATE_HEADER };
      const steps = notices.filter((notice) => notice.landingAt !== undefined).map((notice) => notice.about);
      await this.outbox.deliver(notices, headers, async (text) => {
        // a merge seen on GitHub while this is typed is the coordinator's (handedMerge)
        for (const id of steps) this.handing.add(id);
        let typed: boolean;
        try { typed = this.typed(coordinator, await this.submit(coordinator, text)); } finally { for (const id of steps) this.handing.delete(id); }
        if (!typed) return false;
        // marked sent before the steps leave the outbox, on the run that holds each now (a thread that
        // started again while this was typed moved its step to the new lead): a restart in between finds them sent
        const holders = new Map(this.outbox.pending().map((notice) => [notice.seq, notice.about]));
        for (const notice of notices) {
          const run = notice.landingAt === undefined ? undefined : this.deps.registry.get(holders.get(notice.seq) ?? notice.about);
          if (!run?.landing || run.landing.at !== notice.landingAt) continue;
          run.landing.sent = true;
          this.save(run);
        }
        return true;
      });
    } finally {
      this.delivering.delete(coordinator.id);
    }
  }

  /** the person is writing in the run's input: what the fleet typed would join their draft */
  private async hasDraft(run: AgentRun): Promise<boolean> {
    const draft = adapterFor(run.agent).draft;
    return draft ? draft(await this.deps.runtime.screen(run.herdrName).catch(() => "")) : false;
  }

  private retryNotices(coordinator: AgentRun): void {
    if (this.draftRetries.has(coordinator.id)) return;
    this.draftRetries.set(coordinator.id, setTimeout(() => {
      this.draftRetries.delete(coordinator.id);
      if (!this.stopped) void this.deliverNotices(coordinator);
    }, this.deps.draftRetryMs ?? DRAFT_RETRY_MS));
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
    this.closeUnread(run);
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
        // settlement. The check scheduled at submission (or at a restart) looks again after the grace period.
        const since = pending?.submittedAt ?? pending?.resumedAt;
        if (pending?.armed && !pending.sawWorking && isCompleted(reported) && since !== undefined && Date.now() - since < this.grace) return;
        const current = await this.observed(run, reported);
        if (!isLive(run)) return;
        const previous = run.state;
        // a turn the fleet did not send starts (a helper's result woke the agent, or the person typed)
        if (!pending && current === "working" && (isCompleted(previous) || previous === "blocked")) this.clearTurnFiles(run);
        // a reviewer's turn nobody sent (the person typed, or it woke itself), from whatever state: what it writes is not compared
        if (!pending && current === "working" && run.role === REVIEWER_ROLE) { delete run.reviewClean; run.turnHead ??= "unknown"; }
        if (current !== run.state) this.updateState(run, current);
        if (pending?.armed && run.state === "blocked") await this.reportBlocked(run, pending);
        else if (pending?.armed && isCompleted(run.state)) await this.finalize(run, pending);
        else if (!pending && previous === "working" && isCompleted(run.state) && isThread(run)) await this.settleUnsentTurn(run);
        // free again, after the fleet's turn or the person's: the questions of the threads it hears for
        if (!this.pending.has(run.id) && isCompleted(run.state)) void this.deliverNotices(run);
      } catch (error) {
        if (error instanceof HerdrError && (error.code === "agent_not_found" || error.code === "not_found" || error.code === "pane_not_found")) {
          if (run.state === "starting" && Date.now() - run.startedAt < START_GRACE_MS) return;
          this.closeUnread(run);
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
    await this.readTurn(run, config);
    if (isThread(run)) await this.readThreadWork(run);
    // a thread whose lead run failed or left no report goes on in a new run first, from the contract
    // and change the turn left: what it leaves undone (a landing step, an open plan, the coordinator's
    // news) is the new run's
    const restartError = needsRestart(run) ? await this.restartThread(run, pending.text) : undefined;
    if (isThread(run) && !run.replacedBy) {
      // a turn that failed or left no report went nowhere; a lead taking a thread over starts with
      // its plan still open, and keeps it so while it reports blocked on it
      const report = run.outcome?.report;
      if (report && !(pending.generation === 1 && run.thread && report.state === "blocked")) this.closeStalePlan(run, pending);
      await this.settleThreadTurn(run, config, restartError);
    }
    run.updatedAt = Date.now();
    this.save(run);
    if (run.role === PROJECT_ROLE) await this.settleMerges(run);
    if (isCompleted(run.state)) await this.readUsageScreen(run, config);
    const plan = this.spawnPlans.get(run.id);
    this.spawnPlans.delete(run.id);
    // a helper's failed first turn starts again on the next configured model (a thread's, in a new lead run above)
    if (!isThread(run) && run.state === "failed" && plan && pending.generation === 1) await this.respawn(run, plan);
    this.settleWaiters(run);
    await this.closeOnSettle(run, config);
    if (this.outbox.holds(run.id)) void this.tellCoordinator(run);
  }

  /**
   * The commit a reviewer's settled turn reviewed: the one its folder was at when the turn was sent,
   * kept only when the folder is still there now. A branch that moved during the turn (or before the
   * fleet read it settled) leaves no reviewed commit, and its CLI counts as a writer of the thread.
   */
  private async readReviewedHead(run: AgentRun): Promise<void> {
    const [head, tree] = await Promise.all([this.tools.headCommit(run.cwd).catch(() => null), this.tools.worktreeState(run.cwd).catch(() => null)]);
    const opened = run.turnHead !== undefined;
    const still = opened && head !== null && tree !== null && head === run.turnHead && tree === run.turnTree;
    if (run.outcome?.report && still) run.reportedHead = head!;
    else delete run.reportedHead;
    if (still && run.outcome?.report) run.reviewClean = true;
    else delete run.reviewClean;
    // a worktree that changed in the turn, or one the fleet could not compare, may hold the reviewer's own writing
    if (opened && !still) this.noteWriter(run.group, run.agent);
    delete run.turnHead;
    delete run.turnTree;
  }

  /**
   * A reviewer's turn about to be sent: what its folder holds now, to compare when it settles. A turn
   * before it that the fleet never saw settle (its pane closed, or this one came first) counts its
   * CLI as a writer: what that turn did to the worktree is not known.
   */
  private async openReview(run: AgentRun): Promise<void> {
    if (run.turnHead !== undefined) this.noteWriter(run.group, run.agent);
    delete run.reviewClean;
    const [head, tree] = await Promise.all([this.tools.headCommit(run.cwd).catch(() => null), this.tools.worktreeState(run.cwd).catch(() => null)]);
    // unknown stays open and never matches: the turn's review will not count
    run.turnHead = head ?? "unknown";
    run.turnTree = tree ?? "unknown";
  }

  /** A run that ended without the fleet reading its turn: a reviewer not known clean may have written. */
  private closeUnread(run: AgentRun): void {
    if (run.role !== REVIEWER_ROLE || run.reviewClean) return;
    this.noteWriter(run.group, run.agent);
    delete run.turnHead;
    delete run.turnTree;
  }

  /** `agent` wrote in the thread `group` belongs to: kept on the thread's lead, so it outlives the run's record. */
  private noteWriter(group: string, agent: AgentKind): void {
    // the newest lead run: one that is taking the thread over may not be named on the run before yet
    const lead = this.deps.registry.all().filter((run) => run.group === group && isThread(run) && !run.replacedBy).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!lead || lead.writers?.includes(agent)) return;
    lead.writers = [...(lead.writers ?? []), agent];
    this.save(lead);
  }

  /** What a settled turn left: the screen, the handoff, and the API failure it may have ended on. */
  private async readTurn(run: AgentRun, config: FleetConfig): Promise<void> {
    run.lastOutput = await this.deps.runtime.read(run.herdrName, config.recentReadLines).catch(() => undefined);
    run.result = readResult(this.resultFile(run));
    // a project's coordinator talks with the person and keeps no result folder: it reports nothing
    run.outcome = run.role === PROJECT_ROLE ? undefined : readReport(this.resultDir(run));
    if (run.role === REVIEWER_ROLE) await this.readReviewedHead(run);
    // the thread made progress: the CLIs its runs failed on before get another chance
    if (run.outcome?.report) delete run.avoid;
    this.deps.events?.({
      kind: "turn", run: run.id, role: run.role, agent: run.agent, ...(run.model ? { model: run.model } : {}), group: run.group,
      ...(run.project ? { project: run.project } : {}), interactive: run.interactive, handoff: run.result !== undefined,
      ...(run.outcome ? { report: run.outcome.report?.state ?? "none" } : {}),
    });
    // an API failure (auth, rate limit, outage) ends a turn like any other once the CLI's own retries
    // are spent; a turn that wrote its report did its work, whatever its screen quotes
    const turnError = !run.outcome?.report ? adapterFor(run.agent).turnError(run.lastOutput) : undefined;
    if (turnError && isCompleted(run.state)) {
      run.state = "failed";
      run.lastError = turnError;
      // a rate limit sits the account out: the re-spawn and later spawns pass it over
      this.deps.usage?.noteFailure(run.agent, run.model, turnError, config.rateLimitCooldownMinutes);
    }
  }

  /**
   * A thread's settled turn: its landing step and pull request, and what its coordinator hears, with
   * why the thread could not start again when it could not (its contract and change are read before).
   */
  private async settleThreadTurn(run: AgentRun, config: FleetConfig, restartError?: string): Promise<void> {
    if (run.landing?.sent && !run.landing.error && LEAD_STEPS.has(run.landing.action)) await this.settleLeadStep(run);
    // without the person, or under a gate, a lead opens its pull request itself: read it as its turn ends
    else if (run.pr?.state === "OPEN" || ((config.autonomous || (await this.authorityOf(run)).mode === "gated") && !run.landed)) {
      const reading = await this.readPullRequest(run).catch(() => null);
      // merged while the lead worked (by the person on GitHub): the thread closes now its turn ended
      if (reading?.state === "MERGED" && !run.landed) await this.mergedOnGitHub(run as AgentRun & { project: string; branch: string }, reading);
    }
    if (!run.landed) await this.considerGate(run);
    const news = threadQuestion(run) ?? (config.autonomous ? threadTurnEnded(run) : undefined);
    this.queueNews(run, news && restartError ? `${news}\n  The fleet could not start the thread again on another CLI: ${restartError}` : news);
  }

  /** Who may merge the thread into its base branch: the person, or a gate (the person's fleet.json only). */
  private async authorityOf(run: AgentRun): Promise<MergeAuthority> {
    if (!isThread(run) || !run.project || !run.branch) return { mode: "person" };
    const setting = this.deps.config(run.cwd).projects[run.project]?.merge;
    if (setting?.mode !== "gated") return { mode: "person" };
    return mergeAuthority(setting, await this.baseBranchOf(run as AgentRun & { project: string }));
  }

  /**
   * The merge gate, for a settled thread with an open pull request whose project the person made
   * gated for its base branch: every condition read again now (merge-mode.ts) and kept on the
   * thread. When all hold, the coordinator is handed the merge as if the person had pressed Merge
   * PR, marked as the gate's; otherwise the thread waits for the person, as under `person`.
   */
  private async considerGate(run: AgentRun): Promise<void> {
    if (run.landed || run.replacedBy || run.pr?.state !== "OPEN" || (run.landing && !run.landing.error) || this.pending.has(run.id) || this.gating.has(run.id)) return;
    // a turn's end and the polling may both look: one evaluation at a time, so the merge is handed once
    this.gating.add(run.id);
    try { await this.evaluateGate(run); } finally { this.gating.delete(run.id); }
  }

  private async evaluateGate(run: AgentRun): Promise<void> {
    const reading = await this.readGate(run);
    if (!reading) return;
    run.gate = reading.gate;
    if (reading.gate.ok) run.landing = { action: "merge-pr", at: Date.now(), sent: false, by: "gate", head: reading.gate.head!, pr: reading.pr! };
    run.updatedAt = Date.now();
    this.save(run);
    if (reading.gate.ok) void this.handGateMerge(run as AgentRun & { project: string; branch: string }, reading.baseBranch).catch(() => undefined);
  }

  /**
   * The gate read now, for a thread its project's person made gated: every fact from git, GitHub and
   * the fleet's records of the thread's runs; null when the thread's merges are the person's. What is
   * measured is the commit the pull request is at, against the base branch on GitHub.
   */
  private async readGate(run: AgentRun): Promise<{ gate: GateReading; baseBranch: string; pr?: number } | null> {
    const authority = await this.authorityOf(run);
    if (authority.mode !== "gated") return null;
    const thread = run as AgentRun & { project: string; branch: string };
    const baseBranch = await this.baseBranchOf(thread);
    const [head, reading] = await Promise.all([this.tools.headCommit(run.cwd), this.readPullRequest(thread).catch(() => null)]);
    const compared = reading?.state === "OPEN" ? await this.tools.compareOnGitHub(thread.project, baseBranch, reading.head) : null;
    const members = this.deps.registry.all().filter((member) => member.group === run.group);
    const result = evaluateGate(authority, {
      report: run.outcome?.report?.state,
      contract: run.contract ?? [],
      // the thread keeps who wrote in it; a run's own record says whether it could edit (a role file may have changed since)
      // a reviewer counts as a writer until the fleet saw its last turn leave the worktree as it was
      writers: [...new Set([...(run.writers ?? []), run.agent, ...members.filter((member) => (!member.readOnly && member.role !== REVIEWER_ROLE) || (member.role === REVIEWER_ROLE && !member.reviewClean)).map((member) => member.agent)])],
      reviews: members.filter((member) => member.role === REVIEWER_ROLE && member.reviewClean).map((member) => ({
        agent: member.agent, report: member.outcome?.report?.state, ...(member.reportedHead ? { head: member.reportedHead } : {}),
      })),
      head,
      base: baseBranch,
      ...(reading ? { pr: { state: reading.state, checks: reading.checks, head: reading.head, ...(reading.base ? { base: reading.base } : {}), checksRead: reading.checksRead === true } } : {}),
      lines: compared?.lines ?? null,
      files: compared?.files ?? null,
      behind: compared?.behind ?? null,
    });
    return { gate: { at: Date.now(), ...(reading ? { head: reading.head } : {}), ...result }, baseBranch, ...(reading ? { pr: reading.number } : {}) };
  }

  /**
   * A merge the gate allowed, read again as the coordinator is free to take it: the gate must still
   * hold for the same commit (a new commit, failing checks, a moved base or the person's setting
   * changed since). When it does not, the step is withdrawn and the thread waits for the person.
   */
  private async gateStillHolds(run: AgentRun): Promise<boolean> {
    const step = run.landing!;
    let reading: Awaited<ReturnType<typeof this.readGate>>;
    try { reading = await this.readGate(run); } catch { reading = null; }
    // the person pressed a step of their own meanwhile: it took the gate's place, and stays
    if (run.landing !== step) return false;
    if (reading?.gate.ok && reading.gate.head === step.head && reading.pr === step.pr) return true;
    if (reading) run.gate = reading.gate;
    const why = !reading ? "the project's merges are the person's now" : !reading.gate.ok ? reading.gate.checks.filter((check) => !check.ok).map((check) => check.detail).join(" ")
      : reading.pr !== step.pr ? `the branch's pull request is #${reading.pr ?? "?"} now, not #${step.pr ?? "?"}` : "the pull request moved to another commit";
    run.landing = { ...step, error: `The gate no longer held when the coordinator was free: ${why}` };
    run.updatedAt = Date.now();
    this.save(run);
    return false;
  }

  /** What a thread's lead left in its worktree as its turn settled: its contract and its change since the base. */
  private async readThreadWork(run: AgentRun): Promise<void> {
    const contract = readResult(join(this.deps.resultsDir, run.id, CONTRACT_FILE));
    run.contract = contract ? contractItems(contract) : undefined;
    const base = run.baseBranch ?? run.base;
    const diff = base ? await (this.deps.diffStat ?? diffStat)(run.cwd, base) : null;
    run.diff = diff ?? undefined;
  }

  /**
   * A thread's turn the fleet did not send ended: its agent started it itself (a helper's result
   * woke it after a turn that broke off to wait) or the person typed in its pane. Without the
   * person, nothing else tells the coordinator, which waits for this news to go on.
   */
  private async settleUnsentTurn(run: AgentRun): Promise<void> {
    const config = this.deps.config(run.cwd);
    if (!config.autonomous) return;
    await this.readTurn(run, config);
    await this.readThreadWork(run);
    const restartError = needsRestart(run) ? await this.restartThread(run) : undefined;
    if (!run.replacedBy) await this.settleThreadTurn(run, config, restartError);
    run.updatedAt = Date.now();
    this.save(run);
    this.settleWaiters(run);
    if (this.outbox.holds(run.id)) void this.tellCoordinator(run);
  }

  /**
   * A thread's lead whose run failed or whose turn ended without a report: the thread goes on in a
   * new run of its lead, on a CLI none of its runs failed on since its last report, in the same
   * worktree, branch and fleet (dsh-superagent's new Assignment of the same Ticket). Its task says
   * what happened, where the run before left its handoff, contract and report, and to check before
   * repeating an outside action; the thread's task and the fleet's last message follow. Once it has
   * the task, the old run's pane closes, so one lead works in the worktree. The coordinator hears
   * nothing of a restart, only of one that could not start, with the turn's usual news: this returns
   * why it could not.
   */
  private restartThread(run: AgentRun, lastMessage?: string): Promise<string | undefined> {
    // a landing step pressed before goes first: a discard leaves nothing to start again
    return this.onThread(threadId(run), () => needsRestart(run) ? this.startThreadAgain(run, lastMessage) : Promise.resolve(undefined));
  }

  private async startThreadAgain(run: AgentRun, lastMessage?: string): Promise<string | undefined> {
    const why: "failed" | "no-report" = run.state === "failed" ? "failed" : "no-report";
    const avoid = [...new Set([...(run.avoid ?? []), run.agent])];
    const task = readResult(join(this.resultDir(run), TASK_FILE));
    const base = { kind: "restart" as const, run: run.id, project: run.project!, agent: run.agent, why };
    const since = Date.now();
    let next: AgentRun | undefined;
    try {
      next = await this.spawnWithFallbacks({
        role: THREAD_ROLE, name: run.name, task: recoveryTask(run, this.resultDir(run), task, lastMessage), cwd: run.cwd, depth: run.depth - 1,
        group: run.group, worktree: false, interactive: true, avoid,
        thread: { repo: run.project ?? null, owner: run.owner, base: run.base, baseBranch: run.baseBranch, takeover: { from: run, thread: threadId(run), task } },
      });
      run.replacedBy = next.id;
      // the new run took the landing step over as it started: a step marked sent meanwhile goes as marked
      const lead = this.deps.registry.get(next.id);
      if (lead?.landing && run.landing && lead.landing.at === run.landing.at) {
        lead.landing = run.landing;
        this.save(lead);
      }
      // writers noted on this run while the next one started stay with the thread
      if (lead) {
        lead.writers = [...new Set([...(lead.writers ?? []), ...(run.writers ?? [])])];
        this.save(lead);
      }
      // the thread's question and landing step went to the new run: the old one must not be landed too,
      // and a merge step the coordinator has not heard yet waits for it as the new run's
      this.outbox.drop(run.id, "news");
      this.outbox.move(run.id, next.id);
      delete run.landing;
      await this.deps.runtime.closePane(run.paneId).catch(() => undefined);
      if (isLive(run)) run.state = "stopped";
      this.dropPending(run.id);
      this.deps.events?.({ ...base, by: next.id, to: next.agent });
      run.updatedAt = Date.now();
      this.save(run);
      return undefined;
    } catch (error) {
      if (isAbortError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.events?.({ ...base, error: reason.slice(0, 200) });
      return reason;
    } finally {
      // a candidate that failed to start on the way is no lead of the thread: it points to the run that
      // leads it, and gives back the landing step it was handed, which only that run holds
      const leader = next ?? run;
      for (const failed of this.list()) {
        if (failed.thread !== threadId(run) || failed.id === leader.id || failed.state !== "failed" || failed.replacedBy || failed.startedAt < since) continue;
        failed.replacedBy = leader.id;
        delete failed.landing;
        this.save(failed);
      }
    }
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

  /**
   * A non-interactive run's pane, once its turn settled with its report written. A turn that ended
   * without one keeps its pane: a question the adapter does not know reads as a finished turn
   * (herdr reports agy's file access screen as done), and closing it would end the agent there,
   * where the person or its lead can still see what stopped it and send it on.
   */
  private async closeOnSettle(run: AgentRun, config: FleetConfig): Promise<void> {
    if (!config.closeOnSettle || run.interactive || !isCompleted(run.state) || this.pending.has(run.id)) return;
    if (!run.outcome?.report) return;
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

  /** Looks at the run again after the grace period. Keyed by generation, so a follow-up send never inherits it. */
  private armSettleCheck(run: AgentRun, generation: number): void {
    const timer = setTimeout(() => {
      this.settleChecks.delete(run.id);
      if (this.pending.get(run.id)?.generation === generation) void this.reconcileRun(run);
    }, this.grace);
    this.settleChecks.set(run.id, timer);
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
    // a thread marked done that works again is open again
    if (state === "working") delete run.resolvedAt;
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
    const previous = this.savedStates.get(run.id);
    if (previous !== run.state) {
      this.savedStates.set(run.id, run.state);
      const error = run.lastError && (run.state === "failed" || run.state === "blocked" || run.state === "unknown") ? run.lastError.slice(0, 200) : undefined;
      this.deps.events?.({
        kind: "state", run: run.id, role: run.role, agent: run.agent, ...(run.model ? { model: run.model } : {}), group: run.group,
        ...(run.project ? { project: run.project } : {}), interactive: run.interactive, ...(previous ? { from: previous } : {}), to: run.state, sent: this.pending.has(run.id),
        ...(error ? { error } : {}),
      });
    }
    this.deps.onChanged?.(run);
  }
}

const isThread = (run: AgentRun): boolean => run.role === THREAD_ROLE && run.project !== undefined;

/** A message for a lead run that a new run took the thread over from while it was asked. */
function replaced(run: AgentRun): FleetError {
  return new FleetError("run_ended", `The lead of ${run.name} failed or left no report, and the fleet started the thread again as ${run.replacedBy}; press it again there.`);
}

/** A thread's id: its first lead run's, which names its worktree and branch, whichever run leads it now. */
const threadId = (run: AgentRun): string => run.thread ?? run.id;

/** A thread's settled lead whose run failed or whose turn left no report, and the thread still open: it goes on in a new run. */
const needsRestart = (run: AgentRun): boolean => isThread(run) && !run.landed && !run.replacedBy && (run.state === "failed" || run.outcome?.report === null);

/** What a lead that takes a thread over carries from the run before: the thread, what the fleet knows of its landing, and the CLIs to pass over. */
function carried({ from, thread }: Takeover, avoid: AgentKind[] | undefined): Partial<AgentRun> {
  const { pr, plan, landing, contract, diff, writers } = from;
  return {
    thread, ...(avoid?.length ? { avoid } : {}), writers: [...new Set([...(writers ?? []), from.agent])],
    ...(pr ? { pr } : {}), ...(plan ? { plan } : {}), ...(landing ? { landing } : {}), ...(contract ? { contract } : {}), ...(diff ? { diff } : {}),
  };
}

/** The check before any outside action that a lead taking a thread over is told to make (dsh-superagent's recovery note). */
export const RECOVERY_NOTE = "Check the worktree, git history and GitHub before repeating any outside action (push, PR, comment).";

/** The first task of a lead that takes a thread over from `run`. */
export function recoveryTask(run: AgentRun, resultDir: string, task: string | undefined, lastMessage: string | undefined): string {
  const how = run.state === "failed"
    ? `failed: ${(run.lastError ?? "its turn failed").replace(/\.$/, "")}`
    : `ended its turn without a report (${run.outcome?.report === null ? run.outcome.problem : "no report"})`;
  // the message that started the run before is the thread's task, or this note: neither is repeated
  const last = lastMessage?.trim();
  const repeat = !last || last === task || last.startsWith("[fleet] You take over the thread");
  return [
    `[fleet] You take over the thread "${run.name}" from run ${run.id} on ${run.agent}, which ${how}. This comes from the fleet, not from the person.`,
    `Your folder is the thread's worktree${run.branch ? ` on ${run.branch}` : ""}, where the run before left its work. It left its handoff, contract and report, as far as it wrote them, in ${resultDir}: read them. Your contract starts as its contract; bring it up to date.`,
    RECOVERY_NOTE,
    ...(task ? ["", "The thread's task:", "", task] : []),
    ...(repeat ? [] : ["", "The fleet's last message to the run before:", "", last]),
  ].join("\n");
}

function threadLabel(run: AgentRun): string {
  return `"${run.name}" (${run.id}${run.branch ? `, ${run.branch}` : ""})`;
}

/**
 * A thread's settled turn that asks nothing, as the coordinator of a project run without the person
 * hears it: its report and contract, or how the turn failed, and where the rest is.
 */
export function threadTurnEnded(run: AgentRun): string {
  const status = run.state === "failed" ? `failed — ${run.lastError ?? "the turn failed"}` : run.outcome ? outcomeLine(run.outcome) : "no report";
  const contract = run.contract?.length ? `\n  Contract: ${run.contract.map((item) => `${item.id} ${item.state === "met" ? "✓" : item.state === "unmet" ? "✗" : "…"}`).join(" ")}` : "";
  const pr = run.pr ? `\n  Pull request #${run.pr.number}: ${run.pr.state}${run.landed === "merged" ? ", and the thread is closed" : ""}` : "";
  return `${threadLabel(run)} ended its turn: ${status}${contract}${pr}`;
}

/** A project run without the person that stood still, as its coordinator hears it, with where each open thread stands. */
export function standstill(threads: AgentRun[], quietFor: number): string {
  return [
    `[fleet] Nothing in this project has moved for ${Math.round(quietFor / 60_000)} minutes: you and every thread are settled. This comes from the fleet, not from the person.`,
    ...(threads.length ? threads.map((run) => `- ${threadLabel(run)}: ${run.state}${run.pr ? `, pull request #${run.pr.number} ${run.pr.state}` : ""}`) : ["- No thread is open."]),
    "Check the issues and the threads: start what can start, and send a settled thread what it still has to do. When everything left is blocked or done, say so as your instructions tell you.",
  ].join("\n");
}

/** A thread the fleet closed against GitHub, as its coordinator hears it. */
export function threadClosedAfterMerge(run: AgentRun, settledFor: number): string {
  return `${threadLabel(run)}: GitHub shows pull request #${run.pr?.number ?? "?"} merged and its lead stayed settled ${Math.round(settledFor / 60_000)} minutes, so the fleet closed the thread. Close its issue if it is still open.`;
}

const QUESTIONS_HEADER = "[fleet] Threads ask the person. These come from the fleet, not from the person.";
/** a project run without the person: its coordinator hears every turn a thread ends */
const NEWS_HEADER = "[fleet] Threads ended a turn. These come from the fleet, not from the person.";

/** How the coordinator hears the landing steps the person pressed. */
const STEPS_HEADER = "[fleet] The person pressed these on the Fleet screen. Each is the person's approval for that step only.";
/** How the coordinator hears the merges the person's merge gate allows (merge-mode.ts). */
const GATE_HEADER = "[fleet] The person made this project's merges gated in their own settings, and the fleet found every condition of the gate held for these. Each is your approval for that merge only.";

/** A pull request as a run keeps it: without the commit its branch is at. */
function pullRequest(reading: PullRequestReading): PullRequest {
  const { head: _head, ...pr } = reading;
  return pr;
}

/** A landing step for a thread's lead: what the person approved, and only that (agents/lead.md). */
export function leadStep(run: AgentRun & { branch: string }, action: LandAction, baseBranch: string, comments: LineComment[]): string {
  const pushAgain = run.pr?.state === "OPEN" ? `, and push ${run.branch} to its pull request #${run.pr.number}` : "";
  switch (action) {
    case "pr":
      return `[fleet] The person pressed Create PR on the Fleet screen: they approve pushing ${run.branch} to origin and opening a pull request from it against ${baseBranch}. Commit what is left, push the branch (never force), and open the pull request with gh pr create, its title and body written from this thread's work in the repository's style. Do not merge it. Put the pull request's URL in your HANDOFF.`;
    case "update":
      return `[fleet] The person pressed Update branch on the Fleet screen: ${baseBranch} has commits ${run.branch} does not. Merge ${baseBranch} into ${run.branch}, resolve any conflicts, run the verification again and commit${pushAgain}.`;
    case "fix-ci":
      return `[fleet] The person pressed Fix CI on the Fleet screen: checks failed on pull request #${run.pr?.number}${run.pr?.failing?.length ? ` (${run.pr.failing.join(", ")})` : ""}. Read their logs (gh pr checks ${run.pr?.number}, gh run view --log-failed), fix the cause, commit${pushAgain || `, and push ${run.branch} to its pull request`}.`;
    case "comments":
      return [
        "[fleet] The person reviewed this thread's change on the Fleet screen and left these comments:",
        ...comments.map((comment) => `- ${comment.file}:${comment.line}${comment.removed ? " (a removed line)" : ""} — ${comment.text.replace(/\s+/g, " ").trim()}`),
        `Address each one and commit${pushAgain}. Where you disagree, say why in your HANDOFF instead of changing the code.`,
      ].join("\n");
    default:
      throw new FleetError("invalid_action", `${action} is not a step for a thread's lead.`);
  }
}

/** A merge or a revert for the project's coordinator, on the main checkout it sits on (agents/coordinator.md). */
export function coordinatorStep(run: AgentRun & { branch: string }, baseBranch: string): string {
  const thread = threadLabel(run);
  if (run.landing?.action === "revert") {
    // undone on the branch it was merged into, which a pull request may have been moved to
    baseBranch = run.merged?.base ?? baseBranch;
    // a pull request merged on GitHub is undone on GitHub's base branch too
    const push = run.merged?.via === "local" ? "" : `, and push ${baseBranch} to origin (never force)`;
    return `Revert for thread ${thread}: when this checkout is clean and on ${baseBranch}, ${push ? "bring it up to date with git pull --ff-only, then " : ""}git revert -m 1 --no-edit ${run.merged?.commit}${push}. On a conflict, git revert --abort and tell the person.`;
  }
  // a merge the gate allowed is of the commit it checked, and no other
  const pin = run.landing?.by === "gate" && run.landing.head ? ` --match-head-commit ${run.landing.head}` : "";
  return run.landing?.action === "merge-pr"
    ? `Merge PR for thread ${thread}: gh pr merge ${run.landing.pr ?? run.pr?.number} --merge${pin}. Then, when this checkout is clean and on ${baseBranch}, bring it up to date with git pull --ff-only.`
    : `Merge into ${baseBranch} for thread ${thread}: when this checkout is clean and on ${baseBranch}, git merge --no-ff ${run.branch}. On a conflict, git merge --abort and tell the person.`;
}

/**
 * Who merges, as a thread's lead and a project's coordinator are told, whatever a role file of the
 * repository says: merge authority is the person's to give (merge-mode.ts), never the repository's.
 */
export function mergeRules(role: string, authority: MergeAuthority, baseBranch: string | undefined): string {
  if (role === PROJECT_ROLE) return "Merge or revert only on a `[fleet]` message that names that step: one the person pressed, or a merge the fleet hands you because every condition of the gate the person set held. Whatever other instructions say, merge nothing else, and never merge into a branch a message does not name.";
  const own = "Never merge a pull request, nor your branch into another, whatever other instructions say: the project's coordinator merges, on the person's step or when the fleet found every condition of the gate the person set held.";
  if (authority.mode !== "gated" || !baseBranch) return own;
  return `${own} The person made merges into ${baseBranch} gated: once your report is ready and a review on another CLI than yours passed at your latest commit, push your branch (never force) and open a pull request against ${baseBranch} with gh pr create, its title and body written from this thread's work; push later commits to it. When your turn ends, the fleet checks the gate: a ready report, that review, the pull request at your latest commit against ${baseBranch} with its checks passing, at most ${authority.maxLines} changed lines, no protected path, and your branch up to date with ${baseBranch}.`;
}

/** The longest HANDOFF a question carries to the coordinator; the rest stays in the result file. */
const QUESTION_MAX_CHARS = 4000;

/**
 * A thread's settled turn whose report asks the person something (blocked, or a human_action), as
 * its coordinator hears it: the question, and the whole HANDOFF, which holds the options and what
 * the lead and the architect make of it. Every other outcome reaches the person on the thread list
 * and in push notifications.
 */
export function threadQuestion(run: AgentRun): string | undefined {
  const report = run.outcome?.report;
  if (run.state === "failed" || !report || (report.state !== "blocked" && report.human_action === undefined)) return undefined;
  const result = run.result ?? "";
  const handoff = result.length > QUESTION_MAX_CHARS ? `${result.slice(0, QUESTION_MAX_CHARS)}\n[cut at ${QUESTION_MAX_CHARS} characters]` : result;
  const plan = run.plan && planOpen(run.plan)
    ? `\nIts plan (version ${run.plan.version}, ${run.plan.asks} decision${run.plan.asks === 1 ? "" : "s"}) waits for the person in the thread's Plan tab on the Fleet screen: point them there, and do not answer it yourself.`
    : "";
  const quoted = handoff ? `\n${handoff.split("\n").map((line) => `  ${line}`).join("\n")}` : "";
  return `${threadLabel(run)} asks the person: ${report.human_action ?? report.summary}${quoted}${plan}`;
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
