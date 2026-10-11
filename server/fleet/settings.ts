/**
 * The Settings page's side of the person's fleet.json: what it holds, drawn per role with what the
 * role's file and the project's own fleet.json make of it, and changes written back into it. Keys
 * the page does not know stay as they are.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FleetAgentKind, FleetSettings, FleetSettingsPatch, RoleCandidate, RoleSettings, ThinkingLevel } from "../../shared/fleet.ts";
import { adapterFor, isAgentKind } from "./adapters.ts";
import { DEFAULT_CONFIG, findProjectPath, mergeConfig, userFleetDir } from "./config.ts";
import { parseCandidate } from "./orchestrator.ts";
import { FleetError } from "./runtime.ts";
import { isThinkingLevel, type AgentDefinition, type FleetConfig, type RoleOverride } from "./types.ts";
import type { UsageTracker } from "./usage.ts";

const MAX_CANDIDATES = 8;
const KINDS: readonly FleetAgentKind[] = ["claude", "codex", "cursor", "agy", "opencode", "pi"];
const MAX_SETUP_CHARS = 2000;
const LIMITS = {
  maxUsedPercent: [1, 100], rateLimitCooldownMinutes: [1, 24 * 60], maxConcurrent: [1, 32],
} as const satisfies Record<string, readonly [number, number]>;

export interface FleetSettingsDeps {
  /** the roles that exist in a folder */
  agents: (cwd: string) => AgentDefinition[];
  /** what is known of each account's usage, asking no CLI */
  usage?: Pick<UsageTracker, "known">;
  /** where the person's fleet.json lives; userFleetDir() unless a test says otherwise */
  userDir?: string;
}

/** The person's fleet.json read and written for the Settings page; changes go one at a time. */
export class FleetSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: FleetSettingsDeps) {}

  private get file(): string {
    return join(this.deps.userDir ?? userFleetDir(), "fleet.json");
  }

  /** The settings as the fleet uses them in `cwd`'s project. */
  read(cwd: string): FleetSettings {
    const raw = readUserFile(this.file);
    const user = mergeConfig(DEFAULT_CONFIG, raw);
    const projectFile = findProjectPath(cwd, "fleet.json");
    const projectRoles = projectFile ? readRoles(projectFile) : {};
    const projectConfig = mergeConfig(user, { roles: projectRoles });
    const userRoles = isObject(raw["roles"]) ? raw["roles"] : {};
    const readOnlyAgents = KINDS.filter((kind) => adapterFor(kind).readOnlyArgs);
    const roles = this.deps.agents(cwd).map((definition): RoleSettings => {
      const readOnly = definition.edits === false;
      const own = candidatesOf(definition, {}, DEFAULT_CONFIG);
      const chosen = candidatesOf(definition, user.roles[definition.name] ?? {}, user);
      const setByUser = userRoles[definition.name];
      const setByProject = projectRoles[definition.name];
      return {
        name: definition.name,
        description: definition.description,
        readOnly,
        candidates: chosen.candidates.map((candidate) => {
          const skip = readOnly && !readOnlyAgents.includes(candidate.agent) ? `${candidate.agent} cannot be kept from editing files`
            : this.deps.usage?.known(candidate.agent, candidate.model, user.maxUsedPercent);
          return { ...candidate, ...(skip ? { skip } : {}) };
        }),
        ...(chosen.thinking ? { thinking: chosen.thinking } : {}),
        changed: isObject(setByUser) && ROLE_KEYS.some((key) => key in setByUser),
        defaults: own,
        ...(isObject(setByProject) && ROLE_KEYS.some((key) => key in setByProject) ? { project: candidatesOf(definition, projectConfig.roles[definition.name] ?? {}, projectConfig) } : {}),
      };
    });
    return {
      file: this.file, roles,
      maxUsedPercent: user.maxUsedPercent, rateLimitCooldownMinutes: user.rateLimitCooldownMinutes, maxConcurrent: user.maxConcurrent, closeOnSettle: user.closeOnSettle,
      projects: Object.entries(user.projects).filter(([, project]) => project.setup).map(([path, project]) => ({ path, setup: project.setup! })),
      readOnlyAgents,
    };
  }

  /** Writes `patch` into the person's fleet.json and answers the settings after it. */
  update(cwd: string, patch: FleetSettingsPatch): Promise<FleetSettings> {
    const next = this.queue.catch(() => undefined).then(() => {
      const raw = readUserFile(this.file);
      writeUserFile(this.file, applyPatch(raw, patch, this.deps.agents(cwd)));
      return this.read(cwd);
    });
    this.queue = next;
    return next;
  }
}

const ROLE_KEYS = ["agent", "model", "fallbackModels", "thinking"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A role's candidates in the order the orchestrator tries them (its spawnWithFallbacks): the
 * primary model, then the fallbacks other than it, each read with the role's CLI as the default.
 */
function candidatesOf(definition: AgentDefinition, override: RoleOverride, config: FleetConfig): { candidates: RoleCandidate[]; thinking?: ThinkingLevel } {
  const kind = override.agent ?? definition.agent;
  const primary = override.model ?? definition.model ?? config.defaultModel;
  const entries = [primary, ...(override.fallbackModels ?? definition.fallbackModels ?? []).filter((entry) => entry !== primary)];
  const candidates = entries.map((entry) => {
    const { agent, model } = parseCandidate(entry, kind);
    return model ? { agent, model } : { agent };
  });
  const thinking = override.thinking ?? definition.thinking ?? config.defaultThinking;
  return { candidates, ...(thinking ? { thinking } : {}) };
}

/** The person's fleet.json as written; none yet is an empty one. One that is not a JSON object is not overwritten. */
function readUserFile(file: string): Record<string, unknown> {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new FleetError("settings_unreadable", `Cannot read ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new FleetError("settings_unreadable", `${file} is not valid JSON (${(error as Error).message}). Fix it by hand, then change settings here.`);
  }
  if (!isObject(parsed)) throw new FleetError("settings_unreadable", `${file} is not a JSON object. Fix it by hand, then change settings here.`);
  return parsed;
}

/** The project's fleet.json's roles; one that cannot be read sets none. */
function readRoles(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObject(parsed) && isObject(parsed["roles"]) ? parsed["roles"] : {};
  } catch {
    return {};
  }
}

/** Written to a file beside it and renamed over it: a crash leaves the old file or the new, never half of one. */
function writeUserFile(file: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * `patch` checked and laid over the file's content. A role's first candidate goes to `agent` and
 * `model`, the rest to `fallbackModels`, each as `<agent>:<model>` so the CLI is named even with no
 * model (parseCandidate reads `codex:` as codex's default model).
 */
export function applyPatch(raw: Record<string, unknown>, patch: FleetSettingsPatch, definitions: AgentDefinition[]): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  for (const key of ["maxUsedPercent", "rateLimitCooldownMinutes", "maxConcurrent"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new FleetError("invalid_settings", `${key} must be a whole number from ${min} to ${max}`);
    next[key] = value;
  }
  if (patch.closeOnSettle !== undefined) {
    if (typeof patch.closeOnSettle !== "boolean") throw new FleetError("invalid_settings", "closeOnSettle must be true or false");
    next["closeOnSettle"] = patch.closeOnSettle;
  }
  if (patch.roles !== undefined) {
    if (!isObject(patch.roles)) throw new FleetError("invalid_settings", "roles must be an object");
    const roles: Record<string, unknown> = isObject(raw["roles"]) ? { ...raw["roles"] } : {};
    for (const [name, change] of Object.entries(patch.roles)) {
      const definition = definitions.find((each) => each.name === name);
      if (!definition) throw new FleetError("unknown_role", `Unknown agent role: ${name}`);
      const { agent: _agent, model: _model, fallbackModels: _fallbacks, thinking, ...kept } = isObject(roles[name]) ? roles[name] : {};
      if (change === null) {
        if (Object.keys(kept).length) roles[name] = kept;
        else delete roles[name];
        continue;
      }
      // a change that leaves the thinking level out keeps the one set
      roles[name] = { ...kept, ...(isObject(change) && change.thinking === undefined && thinking !== undefined ? { thinking } : {}), ...roleEntry(definition, change) };
    }
    next["roles"] = roles;
  }
  if (patch.projects !== undefined) {
    if (!isObject(patch.projects)) throw new FleetError("invalid_settings", "projects must be an object");
    const projects: Record<string, unknown> = isObject(raw["projects"]) ? { ...raw["projects"] } : {};
    for (const [path, change] of Object.entries(patch.projects)) {
      if (!isAbsolute(path)) throw new FleetError("invalid_settings", `A project is named by its absolute path: ${path}`);
      const setup = isObject(change) && typeof change["setup"] === "string" ? change["setup"].trim() : undefined;
      if (setup === undefined || setup.length > MAX_SETUP_CHARS) throw new FleetError("invalid_settings", `A setup command is text of up to ${MAX_SETUP_CHARS} characters`);
      const key = resolve(path);
      const { setup: _old, ...kept } = isObject(projects[key]) ? projects[key] : {};
      if (setup) projects[key] = { ...kept, setup };
      else if (Object.keys(kept).length) projects[key] = kept;
      else delete projects[key];
    }
    next["projects"] = projects;
  }
  return next;
}

function roleEntry(definition: AgentDefinition, change: { candidates: RoleCandidate[]; thinking?: ThinkingLevel | null }): Record<string, unknown> {
  if (!isObject(change) || !Array.isArray(change.candidates) || change.candidates.length === 0 || change.candidates.length > MAX_CANDIDATES) {
    throw new FleetError("invalid_settings", `${definition.name} needs from 1 to ${MAX_CANDIDATES} candidates`);
  }
  const entries = change.candidates.map((candidate) => {
    if (!isObject(candidate) || !isAgentKind(candidate.agent)) throw new FleetError("invalid_settings", "Each candidate names a CLI the fleet can start");
    const model = candidate.model === undefined ? "" : candidate.model;
    if (typeof model !== "string" || model.length > 200 || /\s/.test(model)) throw new FleetError("invalid_settings", "A model is a name without spaces, up to 200 characters");
    // a role that edits no file runs only on a CLI the fleet can keep from editing
    if (definition.edits === false && !adapterFor(candidate.agent).readOnlyArgs) throw new FleetError("invalid_settings", `${definition.name} edits no file, and ${candidate.agent} cannot be kept from editing files`);
    return { agent: candidate.agent as FleetAgentKind, entry: `${candidate.agent}:${model}` };
  });
  if (new Set(entries.map((each) => each.entry)).size !== entries.length) throw new FleetError("invalid_settings", "Each candidate may appear once");
  const thinking = change.thinking;
  if (thinking !== undefined && thinking !== null && !isThinkingLevel(thinking)) throw new FleetError("invalid_settings", `Unknown thinking level: ${String(thinking)}`);
  return {
    agent: entries[0]!.agent, model: entries[0]!.entry, fallbackModels: entries.slice(1).map((each) => each.entry),
    ...(thinking ? { thinking } : {}),
  };
}
