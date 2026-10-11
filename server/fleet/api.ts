import { HerdrError } from "../herdr/client.ts";
import { isJsonObject, jsonResponse } from "../http.ts";
import { isAgentKind } from "./adapters.ts";
import { AgentWaitTimeoutError, type Orchestrator, type ThreadRequest } from "./orchestrator.ts";
import { FleetError } from "./runtime.ts";
import { PLAN_MAX_BYTES } from "./plan.ts";
import type { Brief } from "./brief.ts";
import type { FleetSettingsPatch, LandAction, LineComment } from "../../shared/fleet.ts";
import type { SpawnRequest } from "./types.ts";
import type { UsageTracker } from "./usage.ts";
import type { FleetSettingsStore } from "./settings.ts";
import type { EntranceStore } from "./entrances.ts";

/**
 * Fleet HTTP API, behind the same gate as the rest of /api. Changes need X-Herdr-Fleet: 1: a page
 * on another site cannot send that header without a CORS preflight this server never answers.
 *
 *  GET  /api/fleet/roles[?cwd=]                      -> { roles: [{ name, description, agent, source }] }
 *  GET  /api/fleet/runs[?group=]                     -> { runs: AgentRun[] }
 *  POST /api/fleet/spawn         SpawnRequest        -> 201 { run }
 *  POST /api/fleet/threads       { title, task|brief, cwd?, depth?, caller_run? } -> 201 { run }
 *  GET  /api/fleet/threads[?caller_run=&cwd=]        -> { threads: ThreadSummary[] }; the caller's project's
 *  POST /api/fleet/projects      { task, cwd?, from_pane? } -> 201 { run }; the project's coordinator, started or told the task
 *                                                       (from_pane: the herdr pane whose conversation sent it)
 *  GET  /api/fleet/runs/:target[?group=]             -> { run }
 *  POST /api/fleet/runs/:target/send   { message, group? }     -> { run }
 *  POST /api/fleet/runs/:target/wait   { timeout_ms?, group? } -> { run }; 408 wait_timeout with { run }
 *  GET  /api/fleet/runs/:target/read[?lines=&group=] -> { text }
 *  POST /api/fleet/runs/:target/interrupt { group? } -> { run }
 *  POST /api/fleet/runs/:target/focus     { group? } -> { run }
 *  POST /api/fleet/runs/:target/resolve   { resolved?, group? } -> { run }; a thread marked done (resolved: false opens it again)
 *  GET  /api/fleet/runs/:target/diff[?group=]     -> { diff, truncated }; a thread's change since it left its base branch
 *  GET  /api/fleet/runs/:target/landing[?group=]  -> { checks: LandingChecks }; asks git and GitHub (gh) now
 *  POST /api/fleet/runs/:target/land      { action, comments?, group? } -> { run }; a landing step the person pressed
 *  GET  /api/fleet/runs/:target/plan[?group=]     -> { plan }; the plan the thread's lead handed over last (shared/plan.ts)
 *  POST /api/fleet/runs/:target/plan      { plan, group? } -> 201 { plan }; a thread's lead hands over its plan (`fleet plan`)
 *  POST /api/fleet/runs/:target/plan/answer { answer, group? } -> { run }; the person's answers, sent to the lead
 *  POST /api/fleet/close-done             { group? } -> { runs }
 *  GET  /api/fleet/usage                            -> { usage: UsageEntry[] }; what is known, asking no CLI
 *  POST /api/fleet/usage/refresh          { all? }   -> { usage }; asks the CLIs whose reading is stale (all with all: true).
 *                                                       A POST: it runs CLIs, so it needs the header like every change
 *  POST /api/fleet/usage/clear            { key? }   -> { cleared: string[] }; ends cooldowns: one account, a CLI's, or all
 *  GET  /api/fleet/settings[?cwd=]                  -> { settings: FleetSettings }; the person's fleet.json, as the project in cwd uses it
 *  POST /api/fleet/settings      { patch, cwd? }    -> { settings }; the patch written into the person's fleet.json
 *  GET  /api/fleet/entrances                        -> FleetEntrances; the skill folders and whether the fleet skill is in each
 *  POST /api/fleet/entrances     { id, action: "install" | "remove" } -> FleetEntrances
 */
export async function handleFleetRequest(request: Request, url: URL, fleet: Orchestrator, usage?: Pick<UsageTracker, "list" | "refresh" | "clearCooldown">, settings?: Pick<FleetSettingsStore, "read" | "update">, entrances?: Pick<EntranceStore, "list" | "install" | "remove">): Promise<Response> {
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
    if (parts[0] === "threads" && parts.length === 1 && method === "GET") {
      const threads = await fleet.threads({ callerRun: query.get("caller_run") || undefined, cwd: query.get("cwd") || undefined });
      return jsonResponse({ threads });
    }
    if (parts[0] === "projects" && parts.length === 1 && method === "POST") {
      const body = await readBody();
      const task = body["task"];
      const cwd = body["cwd"];
      if (typeof task !== "string" || !task.trim()) throw new FleetError("missing_task", "task is required");
      const fromPane = body["from_pane"];
      if (cwd !== undefined && typeof cwd !== "string") throw new FleetError("invalid_body", "cwd must be a string");
      // the pane id goes into the coordinator's input as written: nothing but an id's characters
      if (fromPane !== undefined && (typeof fromPane !== "string" || !/^[\w:.-]{1,64}$/.test(fromPane))) throw new FleetError("invalid_body", "from_pane must be a herdr pane id");
      const run = await fleet.startProject({ task, ...(cwd ? { cwd } : {}), ...(fromPane ? { fromPane } : {}) }, request.signal);
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
    if (parts[0] === "settings" && parts.length === 1 && settings) {
      if (method === "GET") return jsonResponse({ settings: settings.read(query.get("cwd") || process.cwd()) });
      if (method === "POST") {
        const body = await readBody();
        const cwd = body["cwd"];
        if (cwd !== undefined && typeof cwd !== "string") throw new FleetError("invalid_body", "cwd must be a string");
        if (!isJsonObject(body["patch"])) throw new FleetError("invalid_body", "patch must be an object");
        return jsonResponse({ settings: await settings.update(cwd || process.cwd(), body["patch"] as FleetSettingsPatch) });
      }
    }
    if (parts[0] === "entrances" && parts.length === 1 && entrances) {
      if (method === "GET") return jsonResponse(entrances.list());
      if (method === "POST") {
        const body = await readBody();
        const id = body["id"];
        if (typeof id !== "string") throw new FleetError("invalid_body", "id must be a string");
        if (body["action"] === "install") return jsonResponse(entrances.install(id));
        if (body["action"] === "remove") return jsonResponse(entrances.remove(id));
        throw new FleetError("invalid_body", "action must be install or remove");
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
      if (parts.length === 3 && parts[2] === "diff" && method === "GET") return jsonResponse(await fleet.diff(target, group()));
      if (parts.length === 3 && parts[2] === "landing" && method === "GET") return jsonResponse({ checks: await fleet.checks(target, group()) });
      if (parts[2] === "plan") {
        if (parts.length === 3 && method === "GET") return jsonResponse({ plan: fleet.plan(target, group()) });
        if (parts.length === 3 && method === "POST") {
          const body = await readBody();
          if (Buffer.byteLength(JSON.stringify(body["plan"] ?? null)) > PLAN_MAX_BYTES) throw new FleetError("invalid_plan", `The plan is larger than ${PLAN_MAX_BYTES} bytes.`);
          return jsonResponse({ plan: fleet.submitPlan(target, body["plan"], group(body)) }, 201);
        }
        if (parts.length === 4 && parts[3] === "answer" && method === "POST") {
          const body = await readBody();
          return jsonResponse({ run: await fleet.answerPlan(target, body["answer"], group(body), request.signal) });
        }
      }
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
          case "resolve": {
            const resolved = body["resolved"];
            if (resolved !== undefined && typeof resolved !== "boolean") throw new FleetError("invalid_body", "resolved must be true or false");
            return jsonResponse({ run: fleet.resolve(target, resolved !== false, group(body)) });
          }
          case "land": {
            const action = body["action"];
            if (typeof action !== "string" || !LAND_ACTIONS.includes(action as LandAction)) throw new FleetError("invalid_action", `action must be one of ${LAND_ACTIONS.join(", ")}`);
            const comments = lineComments(body["comments"]);
            return jsonResponse({ run: await fleet.land(target, action as LandAction, comments ? { comments } : {}, group(body), request.signal) });
          }
        }
      }
    }
    return notFound();
  } catch (error) {
    return fleetError(error);
  }
}

const LAND_ACTIONS: readonly LandAction[] = ["update", "pr", "fix-ci", "comments", "merge", "merge-pr", "discard"];
const COMMENTS_MAX = 200;

function lineComments(value: unknown): LineComment[] | undefined {
  if (value === undefined || value === null) return undefined;
  const valid = Array.isArray(value) && value.length <= COMMENTS_MAX && value.every((comment) => isJsonObject(comment)
    && typeof comment["file"] === "string" && comment["file"] !== "" && Number.isInteger(comment["line"]) && (comment["line"] as number) > 0
    && (comment["removed"] === undefined || typeof comment["removed"] === "boolean") && typeof comment["text"] === "string" && comment["text"].trim() !== "");
  if (!valid) throw new FleetError("invalid_body", `comments must be up to ${COMMENTS_MAX} of { file, line, removed?, text }`);
  return (value as Array<Record<string, unknown>>).map((comment) => ({
    file: comment["file"] as string, line: comment["line"] as number, ...(comment["removed"] === true ? { removed: true } : {}), text: comment["text"] as string,
  }));
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
  run_not_found: 404, unknown_role: 404, no_plan: 404, plan_unreadable: 409, agent_blocked: 409, answer_not_delivered: 502, plan_outdated: 409, plan_answered: 409, plan_closed: 409, not_a_thread: 409, thread_landed: 409, landing_busy: 409, run_busy: 409, no_pull_request: 409, diff_unavailable: 409, settings_unreadable: 409, unknown_entrance: 404, entrance_taken: 409, entrance_unreadable: 409, concurrency_limit: 429, depth_limit: 409, run_ended: 409,
  agent_start_failed: 502, fallbacks_exhausted: 502, agent_not_ready: 504, usage_exhausted: 429, scope_conflict: 409, setup_failed: 502,
};

function fleetError(error: unknown): Response {
  if (error instanceof AgentWaitTimeoutError) return jsonResponse({ error: { code: "wait_timeout", message: error.message }, run: error.run }, 408);
  if (error instanceof FleetError) return jsonResponse({ error: { code: error.code, message: error.message } }, STATUS[error.code] ?? 400);
  if (error instanceof HerdrError) return jsonResponse({ error: { code: error.code, message: error.message } }, 502);
  if (error instanceof Error && error.name === "AbortError") return jsonResponse({ error: { code: "aborted", message: "request cancelled" } }, 499);
  return jsonResponse({ error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } }, 500);
}
