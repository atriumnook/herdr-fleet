import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFleetRequest } from "./api.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { Orchestrator } from "./orchestrator.ts";
import { RunRegistry } from "./registry.ts";
import type { AgentRuntime } from "./runtime.ts";
import type { AgentState } from "./types.ts";

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
    closePane: async () => {},
    interrupt: async () => {},
    focus: async () => {},
    reportMetadata: async () => {},
  };
  const orchestrator = new Orchestrator({
    runtime, registry: new RunRegistry(null), config: () => DEFAULT_CONFIG, fleetCommand: "fleet", agentEnv: () => ({}), resultsDir: join(resultsRoot, "results"), promptDir: resultsRoot,
    agents: () => [{ name: "worker", description: "implements", agent: "pi", systemPrompt: "", source: "bundled", filePath: "" }],
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-herdr-fleet": "1" }) => {
    const url = new URL(`http://127.0.0.1:7317/api/fleet${path}`);
    const response = await handleFleetRequest(new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, orchestrator);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { call, state };
}

describe("fleet API", () => {
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
    expect((await call("GET", "/roles")).body["roles"]).toEqual([{ name: "worker", description: "implements", agent: "pi", source: "bundled" }]);
  });

  it("answers bad requests with the reason", async () => {
    const { call } = fleet();
    expect(await call("POST", "/spawn", { task: "t" })).toMatchObject({ status: 400, body: { error: { code: "missing_role" } } });
    expect(await call("POST", "/spawn", { role: "nobody", task: "t" })).toMatchObject({ status: 404, body: { error: { code: "unknown_role" } } });
    expect(await call("POST", "/spawn", { role: "worker", task: "t", worktree: "yes" })).toMatchObject({ status: 400, body: { error: { code: "invalid_body" } } });
    expect(await call("POST", "/spawn", { role: "worker", task: "t", depth: 5 })).toMatchObject({ status: 409, body: { error: { code: "depth_limit" } } });
    expect(await call("GET", "/runs/ghost")).toMatchObject({ status: 404, body: { error: { code: "run_not_found" } } });
    expect(await call("POST", "/runs/ghost/send", { message: "" })).toMatchObject({ status: 400, body: { error: { code: "missing_message" } } });
    expect((await call("GET", "/nowhere")).status).toBe(404);
  });
});
