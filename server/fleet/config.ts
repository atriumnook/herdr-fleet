import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isAgentKind } from "./adapters.ts";
import { isThinkingLevel, type FleetConfig, type ModelPolicy, type ProjectConfig, type RoleOverride } from "./types.ts";

export const DEFAULT_CONFIG: FleetConfig = {
  maxConcurrent: 6,
  // you, a project's coordinator, a thread's lead, the helpers it hands parts to
  maxDepth: 3,
  recentReadLines: 160,
  defaultWaitTimeoutMs: 120_000,
  closeOnSettle: true,
  maxUsedPercent: 90,
  rateLimitCooldownMinutes: 60,
  roles: {},
  models: {},
  projects: {},
};

/** Where the user's fleet config and roles live: $XDG_CONFIG_HOME/herdr-fleet. */
export function userFleetDir(): string {
  return join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr-fleet");
}

/** The nearest `.herdr-fleet/<name>` from `cwd` up, the project's own. */
export function findProjectPath(cwd: string, name: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".herdr-fleet", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readJson(file: string, warnings?: string[]): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") warnings?.push(`fleet: ignoring unreadable ${file}: ${err.message}`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings?.push(`fleet: ignoring ${file}: expected a JSON object`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    warnings?.push(`fleet: ignoring invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Only the keys the file sets with a usable value: an absent key must not erase what a lower config set. */
function parseRole(value: unknown): RoleOverride {
  if (!isObject(value)) return {};
  const role: RoleOverride = {};
  if (isAgentKind(value["agent"])) role.agent = value["agent"];
  if (typeof value["model"] === "string") role.model = value["model"];
  if (isThinkingLevel(value["thinking"])) role.thinking = value["thinking"];
  if (Array.isArray(value["fallbackModels"])) role.fallbackModels = value["fallbackModels"].filter((m): m is string => typeof m === "string" && m.length > 0);
  for (const key of ["worktree", "interactive", "spawning"] as const) if (typeof value[key] === "boolean") role[key] = value[key];
  return role;
}

function parseProject(value: unknown): ProjectConfig {
  if (!isObject(value)) return {};
  return typeof value["setup"] === "string" && value["setup"].trim() ? { setup: value["setup"].trim() } : {};
}

function parseModelPolicy(value: unknown): ModelPolicy {
  if (!isObject(value)) return {};
  const thinking = Array.isArray(value["thinking"]) ? value["thinking"].filter(isThinkingLevel) : undefined;
  return { thinking: thinking?.length ? thinking : undefined };
}

/** `raw` over `base`: known keys only, each checked; what does not parse keeps the base's value. */
export function mergeConfig(base: FleetConfig, raw: Record<string, unknown>): FleetConfig {
  const models = { ...base.models };
  if (isObject(raw["models"])) for (const [name, value] of Object.entries(raw["models"])) models[name] = { ...(models[name] ?? {}), ...parseModelPolicy(value) };
  const roles = { ...base.roles };
  if (isObject(raw["roles"])) for (const [name, value] of Object.entries(raw["roles"])) roles[name] = { ...(roles[name] ?? {}), ...parseRole(value) };
  const projects = { ...base.projects };
  if (isObject(raw["projects"])) for (const [path, value] of Object.entries(raw["projects"])) if (isAbsolute(path)) projects[resolve(path)] = { ...(projects[resolve(path)] ?? {}), ...parseProject(value) };
  const count = (key: string, min: number, fallback: number) => typeof raw[key] === "number" ? Math.max(min, Math.floor(raw[key] as number)) : fallback;
  return {
    defaultModel: typeof raw["defaultModel"] === "string" ? raw["defaultModel"] : base.defaultModel,
    defaultThinking: isThinkingLevel(raw["defaultThinking"]) ? raw["defaultThinking"] : base.defaultThinking,
    maxConcurrent: count("maxConcurrent", 1, base.maxConcurrent),
    maxDepth: count("maxDepth", 0, base.maxDepth),
    recentReadLines: count("recentReadLines", 20, base.recentReadLines),
    defaultWaitTimeoutMs: count("defaultWaitTimeoutMs", 1, base.defaultWaitTimeoutMs),
    closeOnSettle: typeof raw["closeOnSettle"] === "boolean" ? raw["closeOnSettle"] : base.closeOnSettle,
    maxUsedPercent: typeof raw["maxUsedPercent"] === "number" ? Math.min(100, Math.max(1, raw["maxUsedPercent"])) : base.maxUsedPercent,
    rateLimitCooldownMinutes: count("rateLimitCooldownMinutes", 1, base.rateLimitCooldownMinutes),
    roles,
    models,
    projects,
  };
}

/** Built-in defaults, then the user's fleet.json, then the project's `.herdr-fleet/fleet.json`. */
export function loadConfig(cwd: string, warnings?: string[], userDir = userFleetDir()): FleetConfig {
  const project = findProjectPath(cwd, "fleet.json");
  // the project's file comes with the repository: it may tune roles, never name a command to run
  const { projects: _ignored, ...projectRaw } = project ? readJson(project, warnings) : {};
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, readJson(join(userDir, "fleet.json"), warnings)), projectRaw);
}

/**
 * Orders every agent gets with its role, whatever it is asked: the user's `standing.md`, then the
 * project's `.herdr-fleet/standing.md`. A rule given once at spawn fades as work is handed on.
 */
export function loadStandingOrders(cwd: string, userDir = userFleetDir()): string {
  const project = findProjectPath(cwd, "standing.md");
  return [join(userDir, "standing.md"), project].flatMap((file) => {
    if (!file) return [];
    try { return [readFileSync(file, "utf8").trim()].filter(Boolean); } catch { return []; }
  }).join("\n\n");
}
