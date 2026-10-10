import { HerdrError } from "../herdr/client.ts";
import { isJsonObject, jsonResponse } from "../http.ts";
import { isAgentKind } from "./adapters.ts";
import { AgentWaitTimeoutError, type Orchestrator, type ThreadRequest } from "./orchestrator.ts";
import { FleetError } from "./runtime.ts";
import type { Brief } from "./brief.ts";
import type { SpawnRequest } from "./types.ts";
import type { UsageTracker } from "./usage.ts";

/**
 * Fleet HTTP API, behind the same gate as the rest of /api. Changes need X-Herdr-Fleet: 1: a page
 * on another site cannot send that header without a CORS preflight this server never answers.
 *
 *  GET  /api/fleet/roles[?cwd=]                      -> { roles: [{ name, description, agent, source }] }
 *  GET  /api/fleet/runs[?group=]                     -> { runs: AgentRun[] }
 *  POST /api/fleet/spawn         SpawnRequest        -> 201 { run }
 *  GET  /api/fleet/runs/:target[?group=]             -> { run }
 *  POST /api/fleet/runs/:target/send   { message, group? }     -> { run }
 *  POST /api/fleet/runs/:target/wait   { timeout_ms?, group? } -> { run }; 408 wait_timeout with { run }
 *  GET  /api/fleet/runs/:target/read[?lines=&group=] -> { text }
 *  POST /api/fleet/runs/:target/interrupt { group? } -> { run }
 *  POST /api/fleet/runs/:target/focus     { group? } -> { run }
 *  POST /api/fleet/close-done             { group? } -> { runs }
 *  GET  /api/fleet/usage                            -> { usage: UsageEntry[] }; what is known, asking no CLI
 *  POST /api/fleet/usage/refresh          { all? }   -> { usage }; asks the CLIs whose reading is stale (all with all: true).
 *                                                       A POST: it runs CLIs, so it needs the header like every change
 *  POST /api/fleet/usage/clear            { key? }   -> { cleared: string[] }; ends cooldowns: one account, a CLI's, or all
 */
export async function handleFleetRequest(request: Request, url: URL, fleet: Orchestrator, usage?: Pick<UsageTracker, "list" | "refresh" | "clearCooldown">): Promise<Response> {
  const parts = url.pathname.slice("/api/fleet".length).split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method;
  try {
    if (method !== "GET" && request.headers.get("x-herdr-fleet") !== "1") return jsonResponse({ error: { code: "invalid_fleet_request", message: "Send X-Herdr-Fleet: 1" } }, 403);
    const query = url.searchParams;
    const group = (body?: Record<string, unknown>) => {
      const value = body?.["group"] ?? query.get("group");
      return typeof value === "string" && value !== "" ? value : undefined;
    };
    const readBody = async (): Promise<Record<string, unknown>> => {
      let parsed: unknown;
      try { parsed = await request.json(); } catch { throw new FleetError("invalid_json", "request body must be JSON"); }
      if (!isJsonObject(parsed)) throw new FleetError("invalid_body", "request body must be a JSON object");
      return parsed;
    };

    if (parts[0] === "roles" && parts.length === 1 && method === "GET") {
      const roles = fleet.roles(query.get("cwd") || process.cwd()).map(({ name, description, agent, source }) => ({ name, description, agent, source }));
      return jsonResponse({ roles });
    }
    if (parts[0] === "threads" && parts.length === 1 && method === "POST") {
      const body = await readBody();
      const run = await fleet.startThread(threadRequest(body), request.signal);
      return jsonResponse({ run }, 201);
    }
    if (parts[0] === "spawn" && parts.length === 1 && method === "POST") {
      const body = await readBody();
      const run = await fleet.spawn(spawnRequest(body), request.signal);
      return jsonResponse({ run }, 201);
    }
    if (parts[0] === "usage" && usage) {
      if (parts.length === 1 && method === "GET") return jsonResponse({ usage: usage.list() });
      if (parts.length === 2 && parts[1] === "refresh" && method === "POST") {
        const all = (await readBody())["all"];
        if (all !== undefined && typeof all !== "boolean") throw new FleetError("invalid_body", "all must be true or false");
        await usage.refresh(all === true);
        return jsonResponse({ usage: usage.list() });
      }
      if (parts.length === 2 && parts[1] === "clear" && method === "POST") {
        const key = (await readBody())["key"];
        if (key !== undefined && (typeof key !== "string" || key === "")) throw new FleetError("invalid_body", "key must be a non-empty string");
        return jsonResponse({ cleared: usage.clearCooldown(key as string | undefined) });
      }
    }
    if (parts[0] === "close-done" && parts.length === 1 && method === "POST") {
      return jsonResponse({ runs: await fleet.closeDone(group(await readBody())) });
    }
    if (parts[0] === "runs") {
      if (parts.length === 1 && method === "GET") return jsonResponse({ runs: fleet.list(group()) });
      const target = parts[1];
      if (!target) return notFound();
      if (parts.length === 2 && method === "GET") return jsonResponse({ run: fleet.get(target, group()) });
      if (parts.length === 3 && parts[2] === "read" && method === "GET") {
        const lines = query.get("lines");
        return jsonResponse({ text: await fleet.read(target, lines ? Math.max(1, Math.min(10_000, Number(lines) || 0)) : undefined, group()) });
      }
      if (parts.length === 3 && method === "POST") {
        const body = await readBody();
        switch (parts[2]) {
          case "send": {
            if (typeof body["message"] !== "string" || body["message"].trim() === "") throw new FleetError("missing_message", "message is required");
            return jsonResponse({ run: await fleet.send(target, body["message"], group(body), request.signal) });
          }
          case "wait": {
            const timeout = body["timeout_ms"];
            if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1)) throw new FleetError("invalid_timeout", "timeout_ms must be a positive number");
            return jsonResponse({ run: await fleet.wait(target, timeout as number | undefined, group(body), request.signal) });
          }
          case "interrupt": return jsonResponse({ run: await fleet.interrupt(target, group(body)) });
          case "focus": return jsonResponse({ run: await fleet.focus(target, group(body)) });
        }
      }
    }
    return notFound();
  } catch (error) {
    return fleetError(error);
  }
}

function notFound(): Response {
  return jsonResponse({ error: { code: "not_found", message: "Unknown fleet endpoint" } }, 404);
}

function spawnRequest(body: Record<string, unknown>): SpawnRequest {
  const text = (key: string): string | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new FleetError("invalid_body", `${key} must be a string`);
    return value;
  };
  const flag = (key: string): boolean | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") throw new FleetError("invalid_body", `${key} must be true or false`);
    return value;
  };
  const role = text("role");
  const task = text("task");
  if (!role) throw new FleetError("missing_role", "role is required");
  const brief = briefOf(body["brief"]);
  if (!brief && (!task || task.trim() === "")) throw new FleetError("missing_task", "task is required");
  const direction = text("direction");
  if (direction !== undefined && direction !== "right" && direction !== "down") throw new FleetError("invalid_body", "direction must be right or down");
  const avoid = body["avoid"];
  if (avoid !== undefined && avoid !== null && !(Array.isArray(avoid) && avoid.every(isAgentKind))) throw new FleetError("invalid_body", "avoid must be a list of agent CLIs");
  const depth = body["depth"];
  if (depth !== undefined && (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0)) throw new FleetError("invalid_body", "depth must be a whole number");
  return {
    role, task, name: text("name"), model: text("model"), thinking: text("thinking"), cwd: text("cwd"), group: text("group"),
    callerPaneId: text("caller_pane_id"), worktree: flag("worktree"), interactive: flag("interactive"),
    ...(direction ? { direction } : {}), ...(depth !== undefined ? { depth: depth as number } : {}),
    ...(brief ? { brief } : {}),
    ...(Array.isArray(avoid) && avoid.length ? { avoid } : {}),
  };
}

function threadRequest(body: Record<string, unknown>): ThreadRequest {
  const text = (key: string): string | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new FleetError("invalid_body", `${key} must be a string`);
    return value;
  };
  const title = text("title");
  if (!title?.trim()) throw new FleetError("invalid_title", "title is required");
  const brief = briefOf(body["brief"]);
  const task = text("task");
  if (!brief && !task?.trim()) throw new FleetError("missing_task", "task is required");
  const depth = body["depth"];
  if (depth !== undefined && (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0)) throw new FleetError("invalid_body", "depth must be a whole number");
  const callerRun = text("caller_run");
  return { title, task, cwd: text("cwd"), ...(brief ? { brief } : {}), ...(depth !== undefined ? { depth: depth as number } : {}), ...(callerRun ? { callerRun } : {}) };
}

/** The brief's fields as given, each checked for its type; which are missing is the orchestrator's to say. */
function briefOf(value: unknown): Partial<Brief> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isJsonObject(value)) throw new FleetError("invalid_body", "brief must be an object");
  const brief: Partial<Brief> = {};
  for (const key of ["goal", "context", "done", "verify", "forbidden", "timebox"] as const) {
    const field = value[key];
    if (field === undefined || field === null) continue;
    if (typeof field !== "string") throw new FleetError("invalid_body", `brief.${key} must be a string`);
    brief[key] = field;
  }
  const write = value["write"];
  if (write !== undefined && write !== null) {
    if (!Array.isArray(write) || !write.every((path) => typeof path === "string" && path.trim() !== "")) throw new FleetError("invalid_body", "brief.write must be a list of paths");
    brief.write = write;
  }
  return brief;
}

const STATUS: Record<string, number> = {
  run_not_found: 404, unknown_role: 404, concurrency_limit: 429, depth_limit: 409, run_ended: 409,
  agent_start_failed: 502, fallbacks_exhausted: 502, agent_not_ready: 504, usage_exhausted: 429, scope_conflict: 409, setup_failed: 502,
};

function fleetError(error: unknown): Response {
  if (error instanceof AgentWaitTimeoutError) return jsonResponse({ error: { code: "wait_timeout", message: error.message }, run: error.run }, 408);
  if (error instanceof FleetError) return jsonResponse({ error: { code: error.code, message: error.message } }, STATUS[error.code] ?? 400);
  if (error instanceof HerdrError) return jsonResponse({ error: { code: error.code, message: error.message } }, 502);
  if (error instanceof Error && error.name === "AbortError") return jsonResponse({ error: { code: "aborted", message: "request cancelled" } }, 499);
  return jsonResponse({ error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } }, 500);
}
