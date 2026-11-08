/**
 * Starts the real `agy` with the arguments the fleet gives it, in a new folder, and checks what the adapter counts
 * on, with no model: not part of the unit suite (it needs agy on PATH, signed in, or AGY_BIN). Run it after agy
 * updates itself.
 *
 *   bun scripts/agy-live-check.ts
 *
 * agy needs the person's sign-in, so it runs with the person's HOME. It is never sent a prompt: each start is read
 * for a few seconds in a pty and killed. Self-update is off (AGY_CLI_DISABLE_AUTO_UPDATE=true), HERDR_* is dropped,
 * and each start logs to a file of its own (--log-file). The checks:
 * - control: without the fleet's --settings, a new folder gets the trust question (so the reading sees questions);
 * - the fleet's arguments: no trust question, no startup error, nothing the adapter takes for a question, and auto
 *   mode on, on the screen and in agy's log (agy falls back to the default mode without saying so on the screen);
 * - a model id that names its level starts as that model, whatever the role's thinking (agy drops it given --effort);
 * - the person's settings.json is left as it was (--settings is for the session only).
 * Exit code 1 when a check fails.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agyAdapter } from "../server/fleet/adapters.ts";

const BIN = process.env["AGY_BIN"] ?? "agy";
const SETTINGS = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
const TRUST = /Do you trust the contents of this project\?/;
const AUTO = /\bauto ·/;
const READ_MS = 20_000;
const MODE_MS = 10_000;

const root = mkdtempSync(join(tmpdir(), "fleet-agy-live-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR"))) as Record<string, string>;
env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true";

const plain = (bytes: string) =>
  bytes.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "").replace(/\r/g, "\n");

/** agy started with `args` in a new folder, read until it asks to trust the folder or shows its input, then killed. */
async function start(name: string, args: (cwd: string, results: string) => string[]): Promise<{ screen: string; log: string }> {
  const cwd = join(root, name);
  const results = join(root, "results", name);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(results, { recursive: true });
  const logFile = join(root, `${name}.log`);
  let output = "";
  const proc = Bun.spawn([BIN, ...args(cwd, results), "--log-file", logFile], {
    cwd, env, terminal: { cols: 120, rows: 40, data(_terminal, data) { output += new TextDecoder().decode(data); } },
  });
  const deadline = Date.now() + READ_MS;
  // the input shows once agy is signed in; the mode from the settings is set some seconds after that
  while (Date.now() < deadline && !TRUST.test(plain(output)) && !/^\s*>\s*$/m.test(plain(output))) await Bun.sleep(200);
  const settled = Date.now() + MODE_MS;
  while (Date.now() < settled && !TRUST.test(plain(output)) && !AUTO.test(plain(output))) await Bun.sleep(200);
  await Bun.sleep(500);
  proc.kill("SIGKILL");
  await proc.exited;
  return { screen: plain(output), log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "" };
}

const digest = () => (existsSync(SETTINGS) ? createHash("sha256").update(readFileSync(SETTINGS)).digest("hex") : "absent");
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

try {
  const before = digest();

  const control = await start("control", () => []);
  check(TRUST.test(control.screen), "control: a new folder without the fleet's settings gets the trust question");

  const fleet = await start("fleet", (cwd, resultDir) =>
    agyAdapter.launchArgs({ name: "live-check", systemPromptFile: join(root, "instructions.md"), systemPrompt: "", resultDir, cwd }));
  check(!TRUST.test(fleet.screen), "fleet: no trust question in the run's own folder");
  check(agyAdapter.startupError(fleet.screen) === undefined, "fleet: no startup error");
  check(agyAdapter.question?.(fleet.screen) === undefined, "fleet: nothing the adapter takes for a question");
  check(/^\s*>\s*$/m.test(fleet.screen), "fleet: the input shows");
  check(AUTO.test(fleet.screen), "fleet: the screen shows auto mode");
  check(agyAdapter.inputReady?.(fleet.screen) === true, "fleet: the adapter takes the screen for ready");
  check(/SetCycleMode called: auto/.test(fleet.log) && !/auto mode is unavailable/.test(fleet.log), "fleet: agy's log has auto mode set, with no fallback");

  // a model id that names its level, with a role's thinking that differs: the id's level stands
  const level = await start("level", (cwd, resultDir) =>
    agyAdapter.launchArgs({ name: "live-check", model: "gemini-4-argon-low", thinking: "max", systemPromptFile: join(root, "instructions.md"), systemPrompt: "", resultDir, cwd }));
  check(agyAdapter.readyError?.(level.screen) === undefined, "level: a model id that names its level starts as given, with the role's thinking");
  check(/Argon · low/.test(level.screen), "level: the screen shows the id's level");

  check(digest() === before, `the person's ${SETTINGS} is unchanged`);
  if (failures.length) {
    console.log(`\nthe fleet start's screen, last lines:\n${fleet.screen.split("\n").filter((line) => line.trim()).slice(-12).join("\n")}`);
    console.log(`\nits log, on modes and settings:\n${fleet.log.split("\n").filter((line) => /mode|settings/i.test(line)).join("\n")}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
