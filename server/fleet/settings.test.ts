import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Orchestrator } from "./orchestrator.ts";
import { RunRegistry } from "./registry.ts";
import type { AgentRuntime, StartOptions } from "./runtime.ts";
import { FleetSettingsStore } from "./settings.ts";
import type { AgentDefinition } from "./types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const role = (name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name, description: `${name} role`, agent: "pi", systemPrompt: "", source: "bundled", filePath: `${name}.md`, ...extra,
});
const ROLES = [
  role("coordinator", { agent: "claude", thinking: "high", edits: false, interactive: true }),
  role("lead", { agent: "claude", thinking: "high", fallbackModels: ["codex:"], interactive: true }),
  role("reviewer", { thinking: "high" }),
];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  roots.push(root);
  const userDir = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(repo);
  const store = new FleetSettingsStore({
    agents: () => ROLES, userDir,
    usage: { known: (kind) => (kind === "codex" ? "codex has used 92% of its 5h limit" : undefined) },
  });
  const file = join(userDir, "fleet.json");
  return { root, userDir, repo, store, file, written: () => JSON.parse(readFileSync(file, "utf8")) };
}

describe("fleet settings", () => {
  it("draw each role's candidates in the order the fleet tries them, with why one would be passed over now", () => {
    const { store, repo, file } = setup();
    const settings = store.read(repo);
    expect(settings).toMatchObject({ file, maxUsedPercent: 90, rateLimitCooldownMinutes: 60, maxConcurrent: 6, closeOnSettle: true, projects: [], readOnlyAgents: ["claude", "opencode", "pi"] });
    expect(settings.roles.map((each) => [each.name, each.candidates, each.thinking, each.readOnly, each.changed])).toEqual([
      ["coordinator", [{ agent: "claude" }], "high", true, false],
      ["lead", [{ agent: "claude" }, { agent: "codex", skip: "codex has used 92% of its 5h limit" }], "high", false, false],
      ["reviewer", [{ agent: "pi" }], "high", false, false],
    ]);
    expect(settings.roles[1]!.defaults).toEqual({ candidates: [{ agent: "claude" }, { agent: "codex" }], thinking: "high" });
  });

  it("list the roles in the order work passes between them, then the others by name", () => {
    const { userDir, repo } = setup();
    const names = ["worker", "planner", "zeta", "reviewer", "alpha", "scout", "lead", "architect", "coordinator"];
    const store = new FleetSettingsStore({ agents: () => names.map((name) => role(name)), userDir });
    expect(store.read(repo).roles.map((each) => each.name)).toEqual(["coordinator", "lead", "architect", "scout", "worker", "reviewer", "planner", "alpha", "zeta"]);
  });

  it("write a role's candidates into fleet.json, keeping what the page does not set, and the fleet starts the role on them", async () => {
    const { store, repo, file, userDir, written } = setup();
    mkdirSync(userDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ models: { "gpt-6": { thinking: ["high", "xhigh"] } }, roles: { lead: { worktree: false } } }));
    const settings = await store.update(repo, { roles: { lead: { candidates: [{ agent: "codex", model: "gpt-6" }, { agent: "claude" }], thinking: "xhigh" } } });
    expect(written()).toEqual({
      models: { "gpt-6": { thinking: ["high", "xhigh"] } },
      roles: { lead: { worktree: false, agent: "codex", model: "codex:gpt-6", fallbackModels: ["claude:"], thinking: "xhigh" } },
    });
    expect(settings.roles[1]).toMatchObject({ changed: true, thinking: "xhigh", candidates: [{ agent: "codex", model: "gpt-6", skip: "codex has used 92% of its 5h limit" }, { agent: "claude" }] });
    // a change of the candidates alone keeps the thinking level
    await store.update(repo, { roles: { lead: { candidates: [{ agent: "codex", model: "gpt-6" }] } } });
    expect(written().roles.lead.thinking).toBe("xhigh");

    // the orchestrator reads the file the same way: codex with gpt-6 first
    const starts: StartOptions[] = [];
    const runtime: AgentRuntime = {
      createLocation: async (options) => ({ paneId: "w1:p1", cwd: options.cwd }),
      start: async (options) => { starts.push(options); return "idle"; },
      prompt: async () => "working", get: async () => "working", read: async () => "", screen: async () => "",
      closePane: async () => {}, interrupt: async () => {}, focus: async () => {}, reportMetadata: async () => {},
    };
    const fleet = new Orchestrator({
      runtime, registry: new RunRegistry(null), config: (cwd) => loadConfig(cwd, undefined, userDir), agents: () => ROLES, fleetCommand: "fleet", agentEnv: () => ({}),
      resultsDir: join(userDir, "results"), instructionsDir: join(userDir, "instructions"), promptDir: userDir,
    });
    const run = await fleet.spawn({ role: "lead", task: "t", cwd: repo });
    expect(run).toMatchObject({ agent: "codex", model: "gpt-6", thinking: "xhigh" });
    expect(starts[0]!.kind).toBe("codex");
    fleet.stop();
  });

  it("go back to the role's file on Reset, keeping the role's other keys", async () => {
    const { store, repo, file, userDir, written } = setup();
    mkdirSync(userDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ roles: { lead: { agent: "codex", model: "codex:", interactive: true }, reviewer: { model: "pi:x" } } }));
    const settings = await store.update(repo, { roles: { lead: null, reviewer: null } });
    expect(written()).toEqual({ roles: { lead: { interactive: true } } });
    expect(settings.roles[1]).toMatchObject({ changed: false, candidates: [{ agent: "claude" }, { agent: "codex" }] });
  });

  it("set the usage limit, the cooldown, the agents at once, closing helpers' panes and each project's setup command", async () => {
    const { store, repo, written } = setup();
    const settings = await store.update(repo, {
      maxUsedPercent: 80, rateLimitCooldownMinutes: 30, maxConcurrent: 4, closeOnSettle: false,
      projects: { [repo]: { setup: " bun install --ignore-scripts " }, "/elsewhere": { setup: "make" } },
    });
    expect(settings).toMatchObject({ maxUsedPercent: 80, rateLimitCooldownMinutes: 30, maxConcurrent: 4, closeOnSettle: false });
    expect(settings.projects).toEqual([{ path: repo, setup: "bun install --ignore-scripts" }, { path: "/elsewhere", setup: "make" }]);
    await store.update(repo, { projects: { "/elsewhere": { setup: "" } } });
    expect(written().projects).toEqual({ [repo]: { setup: "bun install --ignore-scripts" } });
  });

  it("say when the project's own fleet.json sets a role, and what the fleet uses there", () => {
    const { store, repo } = setup();
    mkdirSync(join(repo, ".herdr-fleet"));
    writeFileSync(join(repo, ".herdr-fleet", "fleet.json"), JSON.stringify({ roles: { reviewer: { agent: "cursor" } } }));
    const settings = store.read(join(repo, "src"));
    expect(settings.roles[2]).toMatchObject({ candidates: [{ agent: "pi" }], project: { candidates: [{ agent: "cursor" }], thinking: "high" } });
    expect(settings.roles[1]!.project).toBeUndefined();
  });

  it("accept pi for a role that edits no file, since pi can be kept from editing", async () => {
    const { store, repo, written } = setup();
    const settings = await store.update(repo, { roles: { coordinator: { candidates: [{ agent: "pi", model: "opencode-go/space-bunny-free" }, { agent: "claude" }] } } });
    expect(written()).toMatchObject({ roles: { coordinator: { agent: "pi", model: "pi:opencode-go/space-bunny-free", fallbackModels: ["claude:"] } } });
    expect(settings.roles[0]!.candidates).toMatchObject([{ agent: "pi" }, { agent: "claude" }]);
    expect(settings.roles[0]!.candidates.some((candidate) => candidate.skip)).toBe(false);
  });

  it("refuse what the fleet could not use, and leave a fleet.json it cannot read as it is", async () => {
    const { store, repo, file, userDir } = setup();
    const refused = (patch: Parameters<typeof store.update>[1]) => store.update(repo, patch).catch((error) => error.code);
    expect(await refused({ roles: { coordinator: { candidates: [{ agent: "codex" }] } } })).toBe("invalid_settings");
    expect(await refused({ roles: { nobody: { candidates: [{ agent: "pi" }] } } })).toBe("unknown_role");
    expect(await refused({ roles: { lead: { candidates: [] } } })).toBe("invalid_settings");
    expect(await refused({ roles: { lead: { candidates: [{ agent: "pi" }, { agent: "pi" }] } } })).toBe("invalid_settings");
    expect(await refused({ roles: { lead: { candidates: [{ agent: "pi", model: "two words" }] } } })).toBe("invalid_settings");
    expect(await refused({ maxUsedPercent: 0 })).toBe("invalid_settings");
    expect(await refused({ maxConcurrent: 2.5 })).toBe("invalid_settings");
    expect(await refused({ projects: { "relative/path": { setup: "make" } } })).toBe("invalid_settings");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(file, "{ not json");
    expect(await refused({ maxConcurrent: 3 })).toBe("settings_unreadable");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    expect(() => store.read(repo)).toThrow("is not valid JSON");
  });
});
