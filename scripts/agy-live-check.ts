/**
 * Starts the real `agy` the way the fleet does, and checks what the adapter counts on against the screen as the fleet
 * reads it, with no model: not part of the unit suite (it needs herdr and agy on PATH, agy signed in). Run it after
 * agy updates itself.
 *
 *   bun scripts/agy-live-check.ts
 *
 * Each start goes through the fleet's own HerdrRuntime in the tests' herdr session (scripts/test-herdr.ts: a headless
 * `herdr-fleet-test`, never the session the person works in), in a workspace of its own on a new folder, and the
 * screen is read with the fleet's read (herdr's recent unwrapped lines). A screen read any other way can differ:
 * agy puts its auto mode's hint inside its input, which a pty's raw output does not show.
 *
 * agy needs the person's sign-in, so it runs with the person's HOME. It is never sent a prompt: each start is read
 * until it settles, then its workspace is closed. Self-update is off (AGY_CLI_DISABLE_AUTO_UPDATE=true) and each start
 * logs to a file of its own (--log-file). The checks:
 * - control: without the fleet's --settings, a new folder stops at the trust question (so the reading sees questions);
 * - the fleet's arguments: no trust question, no startup error, nothing the adapter takes for a question, the adapter
 *   takes the screen for ready within the fleet's wait, and auto mode is on in agy's log (agy falls back to the
 *   default mode without saying so on the screen);
 * - a model id that names its level starts as that model, whatever the role's thinking (agy drops it given --effort);
 * - the person's settings.json is left as it was (--settings is for the session only).
 * Exit code 1 when a check fails.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agyAdapter } from "../server/fleet/adapters.ts";
import { DEFAULT_CONFIG } from "../server/fleet/config.ts";
import { READY_SCREEN_MS } from "../server/fleet/orchestrator.ts";
import { HerdrRuntime } from "../server/fleet/runtime.ts";
import { useTestHerdr } from "./test-herdr.ts";

const SETTINGS = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
const TRUST = /Do you trust the contents of this project\?/;
const LINES = DEFAULT_CONFIG.recentReadLines;

const socket = await useTestHerdr();
if (!socket) {
  console.log("needs herdr on PATH (or HERDR_FLEET_HERDR_BIN), and not HERDR_TEST_MODE=unit or HERDR_TEST_LIVE=1");
  process.exit(1);
}
const runtime = new HerdrRuntime(socket);
const root = mkdtempSync(join(tmpdir(), "fleet-agy-live-"));

/**
 * agy started as the fleet starts it, with `args` in a new folder: the screen once the adapter takes it for ready or
 * for a question, or as it is when the fleet would stop waiting (READY_SCREEN_MS); then its workspace is closed.
 */
async function start(name: string, args: (cwd: string, results: string) => string[]): Promise<Start> {
  const cwd = join(root, name);
  const results = join(root, "results", name);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(results, { recursive: true });
  const logFile = join(root, `${name}.log`);
  const agent = `agy-live-${name}-${process.pid}`;
  const location = await runtime.createLocation({ cwd, label: agent, worktree: false, env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } });
  try {
    const state = await runtime.start({ kind: "agy", name: agent, paneId: location.paneId, args: [...args(cwd, results), "--log-file", logFile], startupError: (screen) => agyAdapter.startupError(screen) });
    const deadline = Date.now() + READY_SCREEN_MS;
    let screen = "";
    let ready = false;
    // herdr itself may take a question for one (`blocked`): the fleet stops there, as this does
    while (state !== "blocked" && Date.now() < deadline) {
      screen = await runtime.read(agent, LINES).catch(() => screen);
      ready = agyAdapter.inputReady?.(screen) === true;
      if (ready || agyAdapter.question?.(screen) || agyAdapter.readyError?.(screen)) break;
      await Bun.sleep(250);
    }
    return { state, screen, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "", ready };
  } finally {
    await runtime.closePane(location.paneId).catch(() => undefined);
  }
}

interface Start { state: string; screen: string; log: string; ready: boolean }

const digest = () => (existsSync(SETTINGS) ? createHash("sha256").update(readFileSync(SETTINGS)).digest("hex") : "absent");
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const launch = (model?: string, thinking?: "max") => (cwd: string, resultDir: string) =>
  agyAdapter.launchArgs({ name: "live-check", model, thinking, systemPromptFile: join(root, "instructions.md"), systemPrompt: "", resultDir, cwd });

let fleet: Start | undefined;
try {
  const before = digest();

  const control = await start("control", () => []);
  check(control.state === "blocked" || agyAdapter.question?.(control.screen) !== undefined, "control: a new folder without the fleet's settings stops at the trust question");

  fleet = await start("fleet", launch());
  check(fleet.state !== "blocked" && !TRUST.test(fleet.screen), "fleet: no trust question in the run's own folder");
  check(agyAdapter.startupError(fleet.screen) === undefined, "fleet: no startup error");
  check(agyAdapter.question?.(fleet.screen) === undefined, "fleet: nothing the adapter takes for a question");
  check(fleet.ready, `fleet: the adapter takes the screen for ready within ${READY_SCREEN_MS / 1000}s`);
  check(/SetCycleMode called: auto/.test(fleet.log) && !/auto mode is unavailable/.test(fleet.log), "fleet: agy's log has auto mode set, with no fallback");

  // a model id that names its level, with a role's thinking that differs: the id's level stands
  const level = await start("level", launch("gemini-4-argon-low", "max"));
  check(agyAdapter.readyError?.(level.screen) === undefined, "level: a model id that names its level starts as given, with the role's thinking");
  check(/Argon · low/.test(level.screen), "level: the screen shows the id's level");

  check(digest() === before, `the person's ${SETTINGS} is unchanged`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  if (fleet) console.log(`\nthe fleet start's screen, as the fleet read it:\n${fleet.screen.split("\n").filter((line) => line.trim()).slice(-12).join("\n")}`);
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
