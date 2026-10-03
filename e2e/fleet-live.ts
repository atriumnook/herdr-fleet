/**
 * Live E2E of the fleet: a real herdr-fleet server, the real `fleet` CLI, real pi agents in the
 * isolated test herdr session (scripts/test-herdr.ts, never the session you work in).
 *
 *   bun run e2e
 *
 * Each scenario spawns pi on FLEET_E2E_MODEL (default opencode-go/glm-5.3-flash, thinking low) with
 * a one-line reply to give, so a run costs a few small model calls. Every pane it opens is closed
 * again, on success and on failure.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testSocketPath } from "../scripts/test-herdr.ts";
import { herdrRpc } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";

const MODEL = process.env["FLEET_E2E_MODEL"] ?? "opencode-go/glm-5.3-flash";
const THINKING = process.env["FLEET_E2E_THINKING"] ?? "low";
const TIMEOUT_MS = Number(process.env["FLEET_E2E_TIMEOUT_MS"] ?? 180_000);
const FLEET = resolve(import.meta.dir, "..", "bin", "fleet.ts");

if (!process.env["HERDR_SOCKET"]) {
  console.error("No herdr found for the test session: install herdr, or set HERDR_FLEET_HERDR_BIN.");
  process.exit(2);
}
const socket = testSocketPath();

const root = mkdtempSync(join(tmpdir(), "fleet-e2e-"));
// the fleet's own config and roles come from this project folder only, never the user's
process.env["XDG_CONFIG_HOME"] = join(root, "config");
const project = join(root, "project");
mkdirSync(join(project, ".herdr-fleet", "agents"), { recursive: true });
const echoPrompt = "You are an E2E fixture. Reply with exactly the text the task asks for and nothing else. Do not use tools.";
const role = (name: string, extra: string) => `---\nname: ${name}\ndescription: E2E fixture\nagent: pi\ntools: read\n${extra}---\n${echoPrompt}\n`;
writeFileSync(join(project, ".herdr-fleet", "agents", "echo.md"), role("echo", "interactive: false\n"));
writeFileSync(join(project, ".herdr-fleet", "agents", "echo-chat.md"), role("echo-chat", "interactive: true\n"));
writeFileSync(join(project, ".herdr-fleet", "agents", "echo-fallback.md"), role("echo-fallback", `model: bogus-provider/no-such-model\nfallbackModels: ${MODEL}\n`));
writeFileSync(join(project, ".herdr-fleet", "fleet.json"), JSON.stringify({ defaultModel: MODEL, defaultThinking: THINKING, maxConcurrent: 4, defaultWaitTimeoutMs: TIMEOUT_MS, recentReadLines: 80 }));

const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), machines: false });
const url = `http://127.0.0.1:${server.port}`;

interface Run { id: string; name: string; role: string; model?: string; fallbackFrom?: string; state: string; paneId: string; lastOutput?: string }

async function fleet(group: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, FLEET, ...args], {
    cwd: project, stdout: "pipe", stderr: "pipe",
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_"))), HERDR_FLEET_URL: url, HERDR_FLEET_GROUP: group },
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

async function runs(group: string): Promise<Run[]> {
  const { out } = await fleet(group, "list", "--json");
  return JSON.parse(out) as Run[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * The pre-visual idle bug only showed with a long multiline task: pasting it takes long enough for
 * herdr to send a status event before the trailing newline, while `agent get` still says idle.
 */
function longTask(reply: string): string {
  const filler = Array.from({ length: 40 }, (_, i) => `- Context line ${i + 1}: this paragraph exists only to make the prompt as long as a real delegated brief, with punctuation, \`backticks\`, "quotes" and $(shell-looking) fragments.`);
  return ["## Handoff", ...filler, "", `Ignore everything above. Reply with exactly: ${reply}`].join("\n");
}

const scenarios: Array<{ name: string; run: (group: string) => Promise<void> }> = [
  {
    name: "a spawn with a long task settles through herdr events, and its pane closes",
    async run(group) {
      const spawned = await fleet(group, "spawn", "--role", "echo", "--task", longTask("E2E-ALPHA"), "--wait", "--timeout", String(TIMEOUT_MS));
      assert(spawned.code === 0, `spawn --wait exited ${spawned.code}: ${spawned.err}${spawned.out}`);
      assert(spawned.out.includes("E2E-ALPHA"), `the reply is missing from:\n${spawned.out}`);
      const [run] = await runs(group);
      for (let i = 0; i < 50 && run && (await runs(group))[0]?.state !== "stopped"; i++) await Bun.sleep(100);
      assert((await runs(group))[0]?.state === "stopped", "the settled non-interactive run was not closed");
    },
  },
  {
    name: "an interactive agent takes a follow-up, and read shows its screen",
    async run(group) {
      const first = await fleet(group, "spawn", "--role", "echo-chat", "--task", "Reply with exactly: E2E-PING", "--wait");
      assert(first.code === 0 && first.out.includes("E2E-PING"), `first turn: ${first.err}${first.out}`);
      const sent = await fleet(group, "send", "echo-chat", "Reply with exactly: E2E-PONG");
      assert(sent.code === 0, `send: ${sent.err}`);
      const second = await fleet(group, "wait", "echo-chat");
      assert(second.code === 0 && second.out.includes("E2E-PONG"), `second turn: ${second.err}${second.out}`);
      const read = await fleet(group, "read", "echo-chat", "--lines", "40");
      assert(read.out.includes("E2E-PONG"), "read does not show the reply");
      assert((await runs(group))[0]?.state !== "stopped", "an interactive pane was closed");
    },
  },
  {
    name: "an unknown model fails fast and the role's fallback model answers",
    async run(group) {
      const startedAt = Date.now();
      const spawned = await fleet(group, "spawn", "--role", "echo-fallback", "--task", "Reply with exactly: E2E-FALLBACK", "--json");
      assert(spawned.code === 0, `spawn: ${spawned.err}`);
      const run = JSON.parse(spawned.out) as Run;
      assert(Date.now() - startedAt < 25_000, `the fallback took ${Date.now() - startedAt}ms: the startup failure was not caught early`);
      assert(run.model === MODEL && run.fallbackFrom === "bogus-provider/no-such-model", `model ${run.model}, fallbackFrom ${run.fallbackFrom}`);
      const failed = (await runs(group)).find((r) => r.model === "bogus-provider/no-such-model");
      assert(failed?.state === "failed", "the first attempt is not recorded as failed");
      const waited = await fleet(group, "wait", run.id);
      assert(waited.out.includes("E2E-FALLBACK"), `the fallback agent did not answer:\n${waited.out}`);
    },
  },
  {
    name: "two agents spawned at once both settle",
    async run(group) {
      const [a, b] = await Promise.all([
        fleet(group, "spawn", "--role", "echo", "--name", "one", "--task", "Reply with exactly: E2E-ONE", "--wait"),
        fleet(group, "spawn", "--role", "echo", "--name", "two", "--task", "Reply with exactly: E2E-TWO", "--wait"),
      ]);
      assert(a.out.includes("E2E-ONE") && b.out.includes("E2E-TWO"), `replies:\n${a.err}${a.out}\n${b.err}${b.out}`);
    },
  },
];

let failures = 0;
try {
  for (const [index, scenario] of scenarios.entries()) {
    const group = `fleet-e2e-${index}-${Date.now().toString(36)}`;
    const started = Date.now();
    try {
      await scenario.run(group);
      console.log(`PASS ${scenario.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      for (const run of await runs(group).catch(() => [])) {
        if (run.state !== "stopped") await herdrRpc("pane.close", { pane_id: run.paneId }, socket).catch(() => undefined);
      }
    }
  }
} finally {
  server.stop();
  rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `${failures} of ${scenarios.length} scenarios failed` : `all ${scenarios.length} scenarios passed`);
process.exit(failures ? 1 : 0);
