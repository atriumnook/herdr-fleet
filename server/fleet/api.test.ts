import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFleetRequest } from "./api.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { Orchestrator } from "./orchestrator.ts";
import { RunRegistry } from "./registry.ts";
import type { AgentRuntime } from "./runtime.ts";
import type { AgentState } from "./types.ts";
import { AUTO_REFRESH_MS, UsageTracker } from "./usage.ts";
import { FleetSettingsStore } from "./settings.ts";
import { EntranceStore } from "./entrances.ts";
import { ModelCatalog } from "./models.ts";

const resultsRoot = mkdtempSync(join(tmpdir(), "fleet-api-"));
afterAll(() => rmSync(resultsRoot, { recursive: true, force: true }));

function fleet() {
  let panes = 0;
  const state: { get: AgentState } = { get: "working" };
  const runtime: AgentRuntime = {
    createLocation: async (options) => ({ paneId: `w1:p${++panes}`, cwd: options.cwd }),
    start: async () => "idle",
    prompt: async () => "working",
    get: async () => state.get,
    read: async () => "recent output",
    screen: async () => "",
    closePane: async () => {},
    interrupt: async () => {},
    focus: async () => {},
    reportMetadata: async () => {},
  };
  const orchestrator = new Orchestrator({
    runtime, registry: new RunRegistry(null), config: () => DEFAULT_CONFIG, fleetCommand: "fleet", landing: { readPullRequest: async () => null }, agentEnv: () => ({}), resultsDir: join(resultsRoot, "results"), instructionsDir: join(resultsRoot, "instructions"), promptDir: resultsRoot,
    agents: () => [
      { name: "worker", description: "implements", agent: "pi", systemPrompt: "", source: "bundled", filePath: "" },
      { name: "coordinator", description: "coordinates", agent: "claude", interactive: true, edits: false, systemPrompt: "", source: "bundled", filePath: "" },
      { name: "lead", description: "leads a thread", agent: "claude", interactive: true, systemPrompt: "", source: "bundled", filePath: "" },
    ],
  });
  let probes = 0;
  const usage = new UsageTracker({ file: null, probes: { codex: async () => { probes += 1; return { codex: { readAt: 1, windows: [{ name: "5h", usedPercent: 20 }] } }; } } });
  const settings = new FleetSettingsStore({ agents: () => orchestrator.roles(resultsRoot), userDir: mkdtempSync(join(resultsRoot, "config-")) });
  const entrances = new EntranceStore({ command: "fleet", url: () => "http://127.0.0.1:7317", tokenRequired: false, home: mkdtempSync(join(resultsRoot, "home-")) });
  const models = new ModelCatalog({ workDir: "/nonexistent", adapter: (kind) => ({ models: kind === "codex" ? { complete: true, list: async () => [{ id: "gpt-6" }] } : undefined }) });
  const reports: Array<{ cwd: string; hours: number; planned?: string }> = [];
  const report = async (cwd: string, hours: number, planned?: string) => { reports.push({ cwd, hours, ...(planned ? { planned } : {}) }); return "# Factory metrics"; };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-herdr-fleet": "1" }) => {
    const url = new URL(`http://127.0.0.1:7317/api/fleet${path}`);
    const response = await handleFleetRequest(new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, orchestrator, usage, settings, entrances, models, report);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { call, state, usage, probes: () => probes, reports };
}

describe("fleet API", () => {
  it("reports a project's factory metrics for the hours and planned label asked, and refuses a request it cannot answer", async () => {
    const { call, reports } = fleet();
    expect(await call("GET", "/report?cwd=%2Frepo&hours=6&planned_label=%5Ephase%3A")).toEqual({ status: 200, body: { report: "# Factory metrics" } });
    expect(await call("GET", "/report?cwd=%2Frepo")).toMatchObject({ status: 200 });
    expect(reports).toEqual([{ cwd: "/repo", hours: 6, planned: "^phase:" }, { cwd: "/repo", hours: 24 }]);
    expect((await call("GET", "/report")).body).toMatchObject({ error: { code: "missing_cwd" } });
    expect((await call("GET", "/report?cwd=%2Frepo&hours=0")).body).toMatchObject({ error: { code: "invalid_hours" } });
    expect((await call("GET", "/report?cwd=%2Frepo&planned_label=%28")).body).toMatchObject({ error: { code: "invalid_planned_label" } });
    expect(reports).toHaveLength(2);
  });

  it("refuses a change without X-Herdr-Fleet: 1, which a page on another site cannot send", async () => {
    const { call } = fleet();
    expect((await call("POST", "/spawn", { role: "worker", task: "t" }, {})).status).toBe(403);
  });

  it("spawns, lists within the caller's fleet, reads, sends and waits", async () => {
    const { call, state } = fleet();
    const spawned = await call("POST", "/spawn", { role: "worker", task: "build it", group: "g1", cwd: "/w", caller_pane_id: "w0:p1", depth: 0 });
    expect(spawned.status).toBe(201);
    expect(spawned.body["run"]).toMatchObject({ role: "worker", group: "g1", state: "working", depth: 1 });
    const id = spawned.body["run"].id as string;
    expect((await call("GET", "/runs?group=g1")).body["runs"]).toHaveLength(1);
    expect((await call("GET", "/runs?group=g2")).body["runs"]).toHaveLength(0);
    expect((await call("GET", `/runs/worker?group=g1`)).body["run"].id).toBe(id);
    expect((await call("GET", `/runs/${id}/read?group=g1&lines=5`)).body).toEqual({ text: "recent output" });
    const timedOut = await call("POST", `/runs/${id}/wait`, { group: "g1", timeout_ms: 20 });
    expect(timedOut.status).toBe(408);
    expect(timedOut.body).toMatchObject({ error: { code: "wait_timeout" }, run: { id, state: "working" } });
    state.get = "working";
    expect((await call("POST", `/runs/${id}/send`, { group: "g1", message: "and test it" })).body["run"].state).toBe("working");
    expect((await call("GET", "/roles")).body["roles"]).toContainEqual({ name: "worker", description: "implements", agent: "pi", source: "bundled" });
  });

  it("lists usage without running a CLI, refreshes stale probes (all with all: true) only on a POST, and clears cooldowns", async () => {
    const { call, usage, probes } = fleet();
    expect((await call("GET", "/usage")).body["usage"]).toEqual([]);
    // a page on another site can send a GET: it must not make the server run CLIs
    expect((await call("POST", "/usage/refresh", {}, {})).status).toBe(403);
    expect(probes()).toBe(0);
    expect((await call("POST", "/usage/refresh", {})).body["usage"]).toEqual([{ key: "codex", reading: { readAt: 1, windows: [{ name: "5h", usedPercent: 20 }] } }]);
    await call("POST", "/usage/refresh", {});
    expect(probes()).toBe(1);
    // the Fleet screen's own refresh (no `all`) leaves a reading tried minutes ago alone; the button forces
    await call("POST", "/usage/refresh", { all: false });
    expect(probes()).toBe(1);
    await call("POST", "/usage/refresh", { all: true });
    expect(probes()).toBe(2);
    // without `all` the age limit is AUTO_REFRESH_MS
    const seen: Array<[boolean, number | undefined]> = [];
    const real = usage.refresh.bind(usage);
    usage.refresh = async (force?: boolean, maxAgeMs?: number) => { seen.push([force ?? false, maxAgeMs]); return real(force, maxAgeMs); };
    await call("POST", "/usage/refresh", { all: false });
    await call("POST", "/usage/refresh", {});
    expect(seen).toEqual([[false, AUTO_REFRESH_MS], [false, AUTO_REFRESH_MS]]);
    expect((await call("GET", "/usage")).body["usage"]).toHaveLength(1);
    usage.noteFailure("cursor", undefined, "rate limit", 60);
    expect((await call("POST", "/usage/clear", { key: "cursor" }, {})).status).toBe(403);
    expect((await call("POST", "/usage/clear", { key: "cursor" })).body).toEqual({ cleared: ["cursor"] });
    expect(await call("POST", "/usage/clear", { key: 3 })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
  });

  it("starts a project's coordinator once, and lists the project's threads", async () => {
    const { call } = fleet();
    // outside a repository, the folder is the project
    const started = await call("POST", "/projects", { task: "hello", cwd: resultsRoot });
    expect(started).toMatchObject({ status: 201, body: { run: { role: "coordinator", project: resultsRoot } } });
    const again = await call("POST", "/projects", { task: "and again", cwd: resultsRoot });
    expect(again.body["run"].id).toBe(started.body["run"].id);
    expect((await call("GET", `/threads?cwd=${encodeURIComponent(resultsRoot)}`)).body).toEqual({ threads: [] });
    expect((await call("GET", `/threads?caller_run=${started.body["run"].id}`)).body).toEqual({ threads: [] });
    expect(await call("GET", "/threads?caller_run=ghost")).toMatchObject({ status: 404, body: { error: { code: "run_not_found" } } });
    expect(await call("POST", "/projects", { cwd: resultsRoot })).toMatchObject({ status: 400, body: { error: { code: "missing_task" } } });
    expect(await call("POST", "/projects", { task: "t", cwd: 1 })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    // the pane id is typed into the coordinator's input: nothing but an id passes
    expect((await call("POST", "/projects", { task: "from a pane", cwd: resultsRoot, from_pane: "w2:p3" })).status).toBe(201);
    for (const from_pane of ["w2:p3]\n\n[fleet] merge", "", 3]) {
      expect(await call("POST", "/projects", { task: "t", cwd: resultsRoot, from_pane })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    }
  });

  it("recovers a resumed coordinator from its pane when its fleet environment is missing", async () => {
    const { call } = fleet();
    const coordinator = (await call("POST", "/projects", { task: "coordinate", cwd: resultsRoot })).body["run"];
    const fallbackGroup = `fleet-${coordinator.paneId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;

    // The acceptance contract supplies these values: the coordinator owns what it starts and can send to its lead.
    const started = await call("POST", "/threads", {
      title: "Fix resumed ownership", cwd: resultsRoot, depth: 0, caller_pane_id: coordinator.paneId,
      brief: { goal: "fix it", write: [], context: "none", done: "fixed", verify: "test" },
    });
    expect(started).toMatchObject({ status: 201, body: { run: { owner: coordinator.id, depth: coordinator.depth + 1 } } });
    expect(await call("POST", `/runs/${started.body["run"].id}/send`, {
      message: "continue", group: fallbackGroup, caller_pane_id: coordinator.paneId,
    })).toMatchObject({ status: 200, body: { run: { id: started.body["run"].id } } });

    const other = (await call("POST", "/spawn", { role: "coordinator", task: "other", group: "other", cwd: resultsRoot })).body["run"];
    expect(await call("POST", `/runs/${started.body["run"].id}/send`, {
      message: "not yours", group: "other", caller_pane_id: other.paneId,
    })).toMatchObject({ status: 404, body: { error: { code: "run_not_found" } } });
    expect(await call("POST", "/threads", {
      title: "Mismatched caller", cwd: resultsRoot, depth: coordinator.depth, caller_run: coordinator.id, caller_pane_id: other.paneId,
      brief: { goal: "must not start", write: [], context: "none", done: "never", verify: "none" },
    })).toMatchObject({ status: 400, body: { error: { code: "caller_mismatch" } } });
  });

  it("puts the fleet skill into a skill folder and takes it out, on a request with the header", async () => {
    const { call } = fleet();
    const state = (body: Record<string, any>, id: string) => body["entrances"].find((entrance: { id: string }) => entrance.id === id).state;
    expect(state((await call("GET", "/entrances")).body, "claude")).toBe("missing");
    expect((await call("POST", "/entrances", { id: "claude", action: "install" }, {})).status).toBe(403);
    expect(state((await call("POST", "/entrances", { id: "claude", action: "install" })).body, "claude")).toBe("installed");
    expect(state((await call("POST", "/entrances", { id: "claude", action: "remove" })).body, "claude")).toBe("missing");
    expect(await call("POST", "/entrances", { id: "claude", action: "overwrite" })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    expect(await call("POST", "/entrances", { id: "home", action: "install" })).toMatchObject({ status: 404, body: { error: { code: "unknown_entrance" } } });
  });

  it("lists the models each CLI offers, and says so when one cannot be asked", async () => {
    const { call } = fleet();
    const { status, body } = await call("GET", "/models");
    expect(status).toBe(200);
    expect(body["listings"].find((each: { agent: string }) => each.agent === "codex")).toEqual({ agent: "codex", models: [{ id: "gpt-6" }], complete: true });
    expect(body["listings"].find((each: { agent: string }) => each.agent === "pi")).toEqual({ agent: "pi", models: [], complete: false });
  });

  it("marks a thread done and opens it again, and refuses a run that is no thread's lead", async () => {
    const { call } = fleet();
    const repo = join(resultsRoot, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    const thread = (await call("POST", "/threads", { title: "Fix", task: "t", cwd: repo })).body["run"];
    expect((await call("POST", `/runs/${thread.id}/resolve`, { group: thread.group })).body["run"].resolvedAt).toBeNumber();
    expect((await call("POST", `/runs/${thread.id}/resolve`, { resolved: false, group: thread.group })).body["run"].resolvedAt).toBeUndefined();
    expect(await call("POST", `/runs/${thread.id}/resolve`, { resolved: "yes", group: thread.group })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    const worker = (await call("POST", "/spawn", { role: "worker", task: "t", group: "g9" })).body["run"];
    expect(await call("POST", `/runs/${worker.id}/resolve`, { group: "g9" })).toMatchObject({ status: 409, body: { error: { code: "not_a_thread" } } });
  });

  it("shows a thread's change and checks, and takes the landing steps the person presses", async () => {
    const { call, state } = fleet();
    const repo = join(resultsRoot, "landing");
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args]);
    Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
    git("commit", "-q", "--allow-empty", "-m", "base");
    const thread = (await call("POST", "/threads", { title: "Fix", task: "t", cwd: repo })).body["run"];
    expect(thread.baseBranch).toBe("main");
    expect((await call("GET", `/runs/${thread.id}/landing?group=${thread.group}`)).body["checks"]).toMatchObject({ baseBranch: "main", behind: 0 });
    expect(await call("GET", `/runs/${thread.id}/diff?group=${thread.group}`)).toMatchObject({ status: 200 });
    // the lead is still at work on its task
    expect(await call("POST", `/runs/${thread.id}/land`, { action: "pr", group: thread.group })).toMatchObject({ status: 409, body: { error: { code: "run_busy" } } });
    expect(await call("POST", `/runs/${thread.id}/land`, { action: "push", group: thread.group })).toMatchObject({ status: 400, body: { error: { code: "invalid_action" } } });
    expect(await call("POST", `/runs/${thread.id}/land`, { action: "comments", comments: [{ file: "a", line: 0, text: "x" }], group: thread.group })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    expect(await call("POST", `/runs/${thread.id}/land`, { action: "merge-pr", group: thread.group })).toMatchObject({ status: 409, body: { error: { code: "no_pull_request" } } });
    state.get = "idle";
    expect((await call("POST", `/runs/${thread.id}/land`, { action: "discard", group: thread.group })).body["run"]).toMatchObject({ landed: "discarded" });
    expect(Bun.spawnSync(["git", "-C", repo, "branch", "--list", thread.branch]).stdout.toString()).toBe("");
    expect(await call("POST", `/runs/${thread.id}/land`, { action: "merge", group: thread.group })).toMatchObject({ status: 409, body: { error: { code: "thread_landed" } } });
  });

  it("takes a thread lead's plan and shows it; the person's answers wait for the lead's turn to end", async () => {
    const { call } = fleet();
    const repo = join(resultsRoot, "plan");
    Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
    Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
    const thread = (await call("POST", "/threads", { title: "Fix", task: "t", cwd: repo })).body["run"];
    const at = (path = "") => `/runs/${thread.id}/plan${path}`;
    expect(await call("GET", at())).toMatchObject({ status: 404, body: { error: { code: "no_plan" } } });
    const plan = { title: "Retry limit", claims: [{ text: "A failed send is tried three times.", exhibit: { kind: "list", items: ["three tries"] },
      ask: { id: "limit", question: "How many?", options: [{ value: "three", label: "3" }, { value: "five", label: "5" }], recommended: "three" } }] };
    expect((await call("POST", at(), { plan }, {})).status).toBe(403);
    expect(await call("POST", at(), { plan: { title: "t" } })).toMatchObject({ status: 400, body: { error: { code: "invalid_plan" } } });
    // counted in bytes: 30,000 characters of Japanese are 90,000 bytes
    expect(await call("POST", at(), { plan: { ...plan, filler: "あ".repeat(30_000) } })).toMatchObject({ status: 400, body: { error: { code: "invalid_plan", message: "The plan is larger than 65536 bytes." } } });
    expect(await call("POST", at(), { plan })).toMatchObject({ status: 201, body: { plan: { version: 1, title: "Retry limit" } } });
    expect((await call("GET", at())).body["plan"]).toMatchObject({ version: 1 });
    expect((await call("GET", `/runs/${thread.id}`)).body["run"].plan).toEqual({ version: 1, asks: 1 });
    // the lead is still at work on its task
    expect(await call("POST", at("/answer"), { answer: { version: 1 } })).toMatchObject({ status: 409, body: { error: { code: "run_busy" } } });
    expect(await call("POST", at("/answer"), { answer: { version: 0 } })).toMatchObject({ status: 409, body: { error: { code: "plan_outdated" } } });
    expect(await call("POST", at("/answer"), { answer: { version: 1, choices: { limit: "ten" } } })).toMatchObject({ status: 400, body: { error: { code: "invalid_answer" } } });
    // a kept plan that does not hold together is answered as such, not as a server error
    writeFileSync(join(resultsRoot, "fleet-plans", `${thread.id}.json`), JSON.stringify({ version: 1, writtenAt: 1, title: "t", claims: [{ text: 5 }] }));
    expect(await call("GET", at())).toMatchObject({ status: 409, body: { error: { code: "plan_unreadable" } } });
  });

  it("reads the settings, and writes a change only with the fleet header", async () => {
    const { call } = fleet();
    const read = await call("GET", `/settings?cwd=${encodeURIComponent(resultsRoot)}`);
    expect(read.body["settings"].roles.map((each: { name: string }) => each.name)).toEqual(["worker", "coordinator", "lead"]);
    expect((await call("POST", "/settings", { patch: { maxConcurrent: 3 } }, {})).status).toBe(403);
    expect((await call("POST", "/settings", { patch: { maxConcurrent: 3 } })).body["settings"].maxConcurrent).toBe(3);
    expect(await call("POST", "/settings", { patch: { roles: { coordinator: { candidates: [{ agent: "cursor" }] } } } })).toMatchObject({ status: 400, body: { error: { code: "invalid_settings" } } });
    expect(await call("POST", "/settings", { patch: 3 })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
  });

  it("answers bad requests with the reason", async () => {
    const { call } = fleet();
    expect(await call("POST", "/spawn", { task: "t" })).toMatchObject({ status: 400, body: { error: { code: "missing_role" } } });
    expect(await call("POST", "/spawn", { role: "nobody", task: "t" })).toMatchObject({ status: 404, body: { error: { code: "unknown_role" } } });
    expect(await call("POST", "/spawn", { role: "worker", task: "t", worktree: "yes" })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    expect(await call("POST", "/spawn", { role: "worker", brief: "fix it" })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    expect(await call("POST", "/spawn", { role: "worker", brief: { goal: "g", write: "src" } })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    expect(await call("POST", "/spawn", { role: "worker", brief: { goal: "g" } })).toMatchObject({ status: 400, body: { error: { code: "incomplete_brief" } } });
    expect(await call("POST", "/spawn", { role: "worker", brief: { goal: "g", write: [], context: "none", done: "d", verify: "v" } })).toMatchObject({ status: 201 });
    expect(await call("POST", "/spawn", { role: "worker", task: "t", avoid: ["gemini"] })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    expect(await call("POST", "/spawn", { role: "worker", task: "t", avoid: "codex" })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    expect(await call("POST", "/spawn", { role: "worker", task: "t", avoid: ["codex"] })).toMatchObject({ status: 201, body: { run: { agent: "pi" } } });
    expect(await call("POST", "/spawn", { role: "worker", task: "t", depth: 5 })).toMatchObject({ status: 409, body: { error: { code: "depth_limit" } } });
    expect(await call("GET", "/runs/ghost")).toMatchObject({ status: 404, body: { error: { code: "run_not_found" } } });
    expect(await call("POST", "/runs/ghost/send", { message: "" })).toMatchObject({ status: 400, body: { error: { code: "missing_message" } } });
    expect((await call("GET", "/nowhere")).status).toBe(404);
  });
});
