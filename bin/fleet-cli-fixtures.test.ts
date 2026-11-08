import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { comparable, loadCases, resolveTarget, RUN_LIMIT_MS, runCase, update, type FleetCliCase } from "../scripts/fleet-cli-fixtures.ts";

/** the CLI under test (HERDR_FLEET_CLI_TARGET); a target that cannot start fails the whole file here */
const command = resolveTarget();
const cases = loadCases();

describe("fleet CLI contract", () => {
  for (const c of cases) {
    test(c.name, async () => {
      expect(c.spec.expected, `${c.name} has no expected value: run bun scripts/fleet-cli-fixtures.ts --update`).toBeDefined();
      expect(comparable(c.spec.expected, await runCase(c.spec, command))).toEqual(c.spec.expected!);
    }, RUN_LIMIT_MS * 2);
  }
});

/**
 * The commands the usage names, with `usage clear` as its own: the corpus must hold a case of each. The
 * usage is the one the `help` case expects, so the check holds for any CLI the corpus is pointed at.
 */
function usageCommands(): string[] {
  const help = cases.find((c) => c.name === "help")?.spec.expected?.stdout;
  if (typeof help !== "string") throw new Error("the help case must expect the usage as text");
  // the command lines end where the notes on <agent> and the exit status begin
  const usage = help.slice(0, help.indexOf("\n\n  <agent> is"));
  return [...new Set([...usage.matchAll(/^ {2}([a-z][a-z-]*(?: clear)?)\b/gm)].map((m) => m[1]!))];
}

const firstWords = (c: FleetCliCase): string => (c.argv[0] === "usage" && c.argv[1] === "clear" ? "usage clear" : c.argv[0] ?? "");

describe("fleet CLI contract coverage", () => {
  const commands = usageCommands();

  test("reads every command of the usage", () => {
    expect(commands).toEqual(["spawn", "thread", "threads", "plan", "project", "guide", "send", "wait", "read", "list", "interrupt", "focus", "close-done", "roles", "usage", "usage clear", "report"]);
  });

  test("has a case of every command, and a --json case of each", () => {
    const covered = new Set(cases.map((c) => firstWords(c.spec)));
    const withJson = new Set(cases.filter((c) => c.spec.argv.includes("--json")).map((c) => firstWords(c.spec)));
    expect(commands.filter((name) => !covered.has(name))).toEqual([]);
    expect(commands.filter((name) => !withJson.has(name))).toEqual([]);
  });

  test("has the variants the issue names", () => {
    const has = (word: string, flag: string) => cases.some((c) => c.spec.argv[0] === word && c.spec.argv.includes(flag));
    for (const word of ["spawn", "thread"]) {
      expect(has(word, "--task")).toBe(true);
      expect(has(word, "--goal")).toBe(true);
    }
    expect(has("list", "--all")).toBe(true);
    expect(has("usage", "--refresh")).toBe(true);
    expect(cases.some((c) => c.spec.argv[0] === "plan" && c.spec.argv[1] === "-")).toBe(true);
    expect(cases.some((c) => c.spec.argv[0] === "plan" && c.spec.files?.[c.spec.argv[1] ?? ""] !== undefined)).toBe(true);
    expect(cases.some((c) => c.spec.argv[0] === "usage" && c.spec.argv[1] === "clear" && c.spec.argv[2])).toBe(true);
    expect([...new Set(cases.map((c) => c.spec.expected?.exitCode))].sort((a, b) => a! - b!)).toEqual([0, 1, 2, 4, 124]);
    expect(cases.some((c) => c.spec.server === "closed")).toBe(true);
    expect(cases.some((c) => c.spec.trailingSlash)).toBe(true);
    for (const name of ["HERDR_FLEET_TOKEN", "HERDR_FLEET_GROUP", "HERDR_FLEET_DEPTH", "HERDR_FLEET_RUN", "HERDR_PANE_ID"]) {
      expect(cases.some((c) => c.spec.env?.[name] !== undefined)).toBe(true);
    }
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function corpus(specs: Record<string, FleetCliCase>): string {
  const root = mkdtempSync(join(tmpdir(), "fleet-cli-fixtures-"));
  roots.push(root);
  for (const [name, spec] of Object.entries(specs)) writeFileSync(join(root, `${name}.json`), JSON.stringify(spec));
  return root;
}
const read = (root: string, name: string) => JSON.parse(readFileSync(join(root, `${name}.json`), "utf8")) as FleetCliCase;

describe("fleet CLI contract runner", () => {
  test("names the target and what is wrong with it when the executable is missing", () => {
    expect(() => resolveTarget("rust:/nonexistent")).toThrow("HERDR_FLEET_CLI_TARGET=rust:/nonexistent: the executable /nonexistent was not found");
    expect(() => resolveTarget("go")).toThrow("HERDR_FLEET_CLI_TARGET=go: give ts, or rust:<path to the executable>");
  });

  test("resolves a relative executable, since the CLI starts in a folder of its own", () => {
    expect(resolveTarget("rust:bin/fleet.ts")).toEqual([join(process.cwd(), "bin", "fleet.ts")]);
  });

  test("refuses a case that sets the variables the runner owns", async () => {
    await expect(runCase({ about: "", argv: ["guide"], env: { HERDR_FLEET_URL: "http://127.0.0.1:7317" } }, command)).rejects.toThrow("may not set HERDR_FLEET_URL");
    await expect(runCase({ about: "", argv: ["guide"], env: { LC_ALL: "C" } }, command)).rejects.toThrow("may not set LC_ALL");
  });

  test("passes the CLI no variable of the test's process but the fixed ones", async () => {
    const saved = process.env["HERDR_FLEET_GROUP"];
    process.env["HERDR_FLEET_GROUP"] = "from-the-test-process";
    try {
      const actual = await runCase({ about: "", argv: ["list"], responses: [{ status: 200, body: { runs: [] } }] }, command);
      expect(actual.requests.map((r) => r.path)).toEqual(["/api/fleet/runs?group=fleet-default"]);
    } finally {
      if (saved === undefined) delete process.env["HERDR_FLEET_GROUP"]; else process.env["HERDR_FLEET_GROUP"] = saved;
    }
  });

  test("update fills only the cases without expected values, and rewrites a named one", async () => {
    const guide = { about: "", argv: ["help"] };
    const root = corpus({ fresh: guide, stale: { ...guide, expected: { requests: [], stdout: "old", stderr: "", exitCode: 0 } } });
    expect(await update([], root, command)).toEqual(["fresh"]);
    expect(read(root, "fresh").expected).toMatchObject({ requests: [], stderr: "", exitCode: 0 });
    expect(read(root, "stale").expected?.stdout).toBe("old");
    expect(await update(["stale"], root, command)).toEqual(["stale"]);
    expect(read(root, "stale").expected?.stdout).toBe(read(root, "fresh").expected?.stdout);
    await expect(update(["missing"], root, command)).rejects.toThrow("no such case: missing");
  });

  test("update writes nothing for a case whose CLI made more requests than it has responses", async () => {
    const root = corpus({ short: { about: "", argv: ["list"] } });
    await expect(update([], root, command)).rejects.toThrow("short: the case has 0 responses, but the CLI made 1 requests");
    expect(read(root, "short").expected).toBeUndefined();
  });

  test("run without --update, an unknown case name fails rather than running nothing", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "scripts", "fleet-cli-fixtures.ts"), "no-such-case"], { stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(err).toContain("no such case: no-such-case");
  });

  test("a pattern compares equal while it matches the whole output, and is kept by update", async () => {
    const spec: FleetCliCase = { about: "", argv: ["bogus"], expected: { requests: [], stdout: "", stderr: { pattern: "fleet: unknown command: bogus\\n[^]*" }, exitCode: 2 } };
    const actual = await runCase(spec, command);
    expect(comparable(spec.expected, actual)).toEqual(spec.expected!);
    expect(comparable({ ...spec.expected!, stderr: { pattern: "unknown command" } }, actual).stderr).toBe(actual.stderr);
    const root = corpus({ kept: spec });
    await update(["kept"], root, command);
    expect(read(root, "kept").expected?.stderr).toEqual(spec.expected!.stderr);
  });
});
