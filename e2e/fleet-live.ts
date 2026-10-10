/**
 * Live E2E of the fleet: a real herdr-fleet server, the real `fleet` CLI, real pi agents in the
 * isolated test herdr session (scripts/test-herdr.ts, never the session you work in).
 *
 *   bun run e2e
 *
 * Each scenario spawns pi on FLEET_E2E_MODEL (default opencode-go/space-bunny-free, thinking off) with
 * a one-line reply to give, so a run costs a few small model calls. Every pane it opens is closed
 * again, on success and on failure.
 *
 * Then each other agent CLI (FLEET_E2E_KINDS, default claude,codex,cursor,agy) takes one turn on its
 * cheapest model at the lowest level, in a fixed folder (FLEET_E2E_KINDS_DIR, default
 * ~/.cache/herdr-fleet-e2e/project). A CLI that does not trust that folder yet is started there
 * first and its trust question answered: that is written to the CLI's own settings, once. The
 * server keeps its state beside it (state/), so the result folders' root cursor is given stays the
 * same, and its trust question too is answered once.
 *
 * Two more check what is unverified: codex runs the fleet CLI from inside its sandbox (the CLI
 * talks to this server over localhost HTTP), and an interactive cursor agent takes a second turn
 * (its question detection reads the empty input's placeholder). FLEET_E2E_ONLY=<words> runs only the
 * scenarios whose names hold one of those comma-separated words, since every scenario costs model
 * calls: FLEET_E2E_ONLY=sandbox,"second turn" runs just these two.
 *
 * One more starts a thread (FLEET_E2E_ONLY=thread): claude leads it on a worktree inside the fixed
 * folder, which becomes a small repository, and codex reviews the change. Another
 * (FLEET_E2E_ONLY=coordinator) has the project's coordinator start that thread itself, edit nothing,
 * and report the thread's result, which the fleet hands it once the thread's turn is over.
 *
 * Start the test session clean before a run: it hands its environment to every agent.
 *   herdr --session herdr-fleet-test server stop
 *   env $(env | grep -oE '^(HERDR|CLAUDE|CODEX_COMPANION)[A-Z_]*' | sed 's/^/-u /') AGY_CLI_DISABLE_AUTO_UPDATE=true bun run e2e
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testSocketPath } from "../scripts/test-herdr.ts";
import { herdrRpc } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";

const MODEL = process.env["FLEET_E2E_MODEL"] ?? "opencode-go/space-bunny-free";
const THINKING = process.env["FLEET_E2E_THINKING"] ?? "off";
/** each CLI's cheapest model; the level is the lowest it takes (thinking off maps to it) */
const KIND_MODELS: Record<string, string> = {
  // the cheapest Claude model auto mode runs on: Haiku starts in manual mode
  claude: process.env["FLEET_E2E_CLAUDE_MODEL"] ?? "claude-sonnet-5-5",
  codex: process.env["FLEET_E2E_CODEX_MODEL"] ?? "gpt-6-luna",
  cursor: process.env["FLEET_E2E_CURSOR_MODEL"] ?? "gemini-3.8-flash-low",
  agy: process.env["FLEET_E2E_AGY_MODEL"] ?? "gemini-3.8-flash-low",
};
const KINDS = (process.env["FLEET_E2E_KINDS"] ?? "claude,codex,cursor,agy").split(",").map((k) => k.trim()).filter(Boolean);
const KINDS_DIR = resolve(process.env["FLEET_E2E_KINDS_DIR"] ?? join(homedir(), ".cache", "herdr-fleet-e2e", "project"));
const STATE_DIR = join(KINDS_DIR, "..", "state");
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

// the other CLIs' roles: the reply has to reach the result file, which is what is checked
mkdirSync(join(KINDS_DIR, ".herdr-fleet", "agents"), { recursive: true });
const kindPrompt = "You are an E2E fixture. Your HANDOFF is exactly the text the task gives, and nothing else. Write it to your result file with your file-writing tool, then reply with it. Do nothing else.";
for (const kind of KINDS) {
  writeFileSync(join(KINDS_DIR, ".herdr-fleet", "agents", `echo-${kind}.md`), `---\nname: echo-${kind}\ndescription: E2E fixture\nagent: ${kind}\nmodel: ${KIND_MODELS[kind]}\nthinking: off\ninteractive: false\n---\n${kindPrompt}\n`);
}
// codex runs the fleet CLI: the list it prints names the run itself, which only the server knows
if (KINDS.includes("codex")) writeFileSync(join(KINDS_DIR, ".herdr-fleet", "agents", "fleet-codex.md"), `---\nname: fleet-codex\ndescription: E2E fixture\nagent: codex\nmodel: ${KIND_MODELS["codex"]}\nthinking: off\ninteractive: false\n---\nYou are an E2E fixture. Run the fleet command your instructions name with the single argument list, in your shell. Your HANDOFF is exactly what that command prints, or its error if it fails. Write it to your result file with your file-writing tool, then reply with it. Do nothing else.\n`);
// cursor stays open for a second turn
if (KINDS.includes("cursor")) writeFileSync(join(KINDS_DIR, ".herdr-fleet", "agents", "chat-cursor.md"), `---\nname: chat-cursor\ndescription: E2E fixture\nagent: cursor\nmodel: ${KIND_MODELS["cursor"]}\nthinking: off\ninteractive: true\n---\n${kindPrompt}\n`);
writeFileSync(join(KINDS_DIR, ".herdr-fleet", "fleet.json"), JSON.stringify({
  maxConcurrent: 4, defaultWaitTimeoutMs: TIMEOUT_MS, recentReadLines: 80,
  // a thread's lead and its reviewer on each CLI's cheapest model, with no fallback to pay for
  roles: {
    coordinator: { model: KIND_MODELS["claude"], thinking: "low" },
    lead: { model: KIND_MODELS["claude"], thinking: "low", fallbackModels: [] },
    reviewer: { agent: "codex", model: KIND_MODELS["codex"], thinking: "off", fallbackModels: [] },
  },
}));

// a recent usage reading from an earlier run would keep this run from reading cursor's screen again
rmSync(join(STATE_DIR, "fleet-usage.json"), { force: true });
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: STATE_DIR, machines: false });
const url = `http://127.0.0.1:${server.port}`;

interface Run { id: string; name: string; role: string; model?: string; fallbackFrom?: string; state: string; paneId: string; lastOutput?: string; result?: string; lastError?: string }

async function fleet(group: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return fleetIn(project, group, ...args);
}

async function fleetIn(cwd: string, group: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, FLEET, ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
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

/** the option that trusts the folder, in each CLI's trust question */
const TRUST_YES = /Yes, I trust this folder|Trust and continue|Trust this workspace/;

/**
 * Answers the trust question on a pane if one shows within ~20 s: the cursor is moved onto the
 * trusting option, wherever the CLI put it, and confirmed. False when none showed.
 */
async function answerTrust(paneId: string, label: string): Promise<boolean> {
  const screen = async () => (await herdrRpc<{ read?: { text?: string } }>("pane.read", { pane_id: paneId, source: "recent", lines: 60 }, socket)).read?.text ?? "";
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    const lines = (await screen()).split("\n");
    const target = lines.findIndex((line) => TRUST_YES.test(line));
    if (target < 0) continue;
    // the marked option nearest the trusting one: a shell prompt above may use the same mark
    const marked = lines.map((line, index) => /^[\s│]*[❯›>▶] /.test(line) ? index : -1).filter((index) => index >= 0 && Math.abs(index - target) <= 4);
    const selected = marked.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    const moves = selected === undefined ? 0 : target - selected;
    const keys = [...Array(Math.abs(moves)).fill(moves > 0 ? "down" : "up"), "enter"];
    for (const key of keys) { await herdrRpc("pane.send_keys", { pane_id: paneId, keys: [key] }, socket); await Bun.sleep(150); }
    // the answered question stays in the scrollback: whether it took shows in what follows
    await Bun.sleep(3000);
    console.log(`${label}: answered its trust question`);
    return true;
  }
  return false;
}

/** Starts `kind` in the fixed folder and answers its trust question if it asks one. Sends no prompt. */
async function trustFolder(kind: string): Promise<void> {
  const created = await herdrRpc<{ root_pane?: { pane_id?: string } }>("workspace.create", { cwd: KINDS_DIR, label: `e2e-trust-${kind}`, focus: false }, socket);
  const paneId = created.root_pane?.pane_id;
  assert(paneId, "workspace.create returned no pane");
  try {
    await Bun.sleep(1500);
    await herdrRpc("agent.start", { name: `e2e-trust-${kind}-${Date.now().toString(36)}`, kind, pane_id: paneId, args: [] }, socket, 15_000);
    await answerTrust(paneId, `${kind} in ${KINDS_DIR}`);
  } finally {
    await herdrRpc("pane.close", { pane_id: paneId }, socket).catch(() => undefined);
  }
}

for (const kind of KINDS) {
  scenarios.push({
    name: `${kind} takes a turn on ${KIND_MODELS[kind]} and hands its result back through the result file`,
    async run(group) {
      await trustFolder(kind);
      const startedAt = Date.now();
      const token = `E2E-${kind.toUpperCase()}-${Date.now().toString(36)}`;
      const task = `The text is: ${token}`;
      let waited = await fleetIn(KINDS_DIR, group, "spawn", "--role", `echo-${kind}`, "--task", task, "--wait", "--timeout", String(TIMEOUT_MS));
      let [run] = await runs(group);
      // cursor asks to trust the result folders' root at its first start: answered, then the task goes
      if (run?.state === "blocked" && /trust this folder/.test(run.lastError ?? "")) {
        assert(await answerTrust(run.paneId, `${kind} for the result folders`), `blocked with no trust question on screen: ${run.lastError}`);
        await fleetIn(KINDS_DIR, group, "send", run.id, task);
        waited = await fleetIn(KINDS_DIR, group, "wait", run.id, "--timeout", String(TIMEOUT_MS));
        [run] = await runs(group);
      }
      const facts = `state ${run?.state}, error ${run?.lastError ?? "none"}\n${waited.err}${waited.out}\n--- screen\n${run?.lastOutput ?? "(none)"}`;
      assert(waited.code === 0, `exited ${waited.code}; ${facts}`);
      assert(run?.result?.includes(token), `the result file does not hold ${token} (${JSON.stringify(run?.result)}); ${facts}`);
      // cursor tells its usage only on its /usage screen: the fleet reads it once the turn settled, before the wait returns
      if (kind === "cursor") {
        const { usage } = await (await fetch(`${url}/api/fleet/usage`)).json() as { usage: Array<{ key: string; reading?: { readAt: number; windows: Array<{ resetsAt?: number }> } }> };
        const entry = usage.find((e) => e.key === "cursor");
        assert(entry?.reading && entry.reading.readAt >= startedAt && entry.reading.windows.length, `no cursor usage was read from its /usage screen this turn: ${JSON.stringify(entry)}`);
        assert(entry.reading.windows.every((w) => w.resetsAt), `cursor's reset date was not read: ${JSON.stringify(entry.reading)}`);
        console.log(`cursor usage: ${JSON.stringify(entry.reading.windows)}`);
      }
    },
  });
}

/** Spawns `role` in the fixed folder, answering cursor's trust question for the result folders if it asks. */
async function spawnKind(kind: string, group: string, role: string, task: string): Promise<{ waited: { code: number; out: string; err: string }; run: Run | undefined }> {
  let waited = await fleetIn(KINDS_DIR, group, "spawn", "--role", role, "--task", task, "--wait", "--timeout", String(TIMEOUT_MS));
  let [run] = await runs(group);
  if (run?.state === "blocked" && /trust this folder/.test(run.lastError ?? "")) {
    assert(await answerTrust(run.paneId, `${kind} for the result folders`), `blocked with no trust question on screen: ${run.lastError}`);
    await fleetIn(KINDS_DIR, group, "send", run.id, task);
    waited = await fleetIn(KINDS_DIR, group, "wait", run.id, "--timeout", String(TIMEOUT_MS));
    [run] = await runs(group);
  }
  return { waited, run };
}

const factsOf = (run: Run | undefined, waited: { out: string; err: string }) =>
  `state ${run?.state}, error ${run?.lastError ?? "none"}\n${waited.err}${waited.out}\n--- screen\n${run?.lastOutput ?? "(none)"}`;

if (KINDS.includes("codex")) {
  scenarios.push({
    name: "codex reaches the fleet CLI from inside its sandbox",
    async run(group) {
      await trustFolder("codex");
      const { waited, run } = await spawnKind("codex", group, "fleet-codex", "Do what your role says.");
      const facts = factsOf(run, waited);
      assert(waited.code === 0, `exited ${waited.code}; ${facts}`);
      assert(run?.result?.includes(run.name), `the list codex printed does not name its own run ${run?.name} (${JSON.stringify(run?.result)}); ${facts}`);
    },
  });
}

if (KINDS.includes("cursor")) {
  scenarios.push({
    name: "an interactive cursor agent takes a second turn and is not taken for a question",
    async run(group) {
      await trustFolder("cursor");
      const first = `E2E-CURSOR-1-${Date.now().toString(36)}`;
      const firstTurn = await spawnKind("cursor", group, "chat-cursor", `The text is: ${first}`);
      assert(firstTurn.waited.code === 0 && firstTurn.run?.result?.includes(first), `first turn; ${factsOf(firstTurn.run, firstTurn.waited)}`);
      const second = `E2E-CURSOR-2-${Date.now().toString(36)}`;
      const sent = await fleetIn(KINDS_DIR, group, "send", firstTurn.run!.id, `The text is now: ${second}`);
      assert(sent.code === 0, `send: ${sent.err}`);
      const waited = await fleetIn(KINDS_DIR, group, "wait", firstTurn.run!.id, "--timeout", String(TIMEOUT_MS));
      const [run] = await runs(group);
      const facts = factsOf(run, waited);
      // exit 4 is "blocked on a question": the second turn's empty input must read as done, not as one
      assert(waited.code === 0, `second turn exited ${waited.code}; ${facts}`);
      assert(run?.state !== "blocked", `the second turn was taken for a question; ${facts}`);
      assert(run?.result?.includes(second), `the result file does not hold ${second} (${JSON.stringify(run?.result)}); ${facts}`);
    },
  });
}

/** a thread's turn is a lead's whole job: it works, hands the review on and waits for it */
const THREAD_TIMEOUT_MS = Number(process.env["FLEET_E2E_THREAD_TIMEOUT_MS"] ?? 900_000);

/** The fixed folder as a repository with one small task in it, committed once; a run leaves it as it was. */
function threadRepo(): void {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-C", KINDS_DIR, ...args], { stdout: "pipe", stderr: "pipe" });
  if (git("rev-parse", "--verify", "HEAD").exitCode === 0) return;
  git("init", "-q", "-b", "main");
  writeFileSync(join(KINDS_DIR, "greet.mjs"), "export function greet() {\n  return \"hello\";\n}\n");
  writeFileSync(join(KINDS_DIR, "check.mjs"), "import { greet } from \"./greet.mjs\";\nif (greet() !== \"hello, fleet\") { console.error(`greet() returned ${JSON.stringify(greet())}`); process.exit(1); }\nconsole.log(\"ok\");\n");
  git("add", "greet.mjs", "check.mjs");
  const committed = git("-c", "user.email=e2e@example.invalid", "-c", "user.name=fleet e2e", "commit", "-q", "-m", "e2e fixture");
  assert(committed.exitCode === 0, `could not commit the thread fixture: ${committed.stderr.toString()}`);
}

if (KINDS.includes("claude") && KINDS.includes("codex")) {
  scenarios.push({
    name: "a thread's lead works on its own worktree, has the change reviewed on another CLI, and meets its contract",
    async run() {
      threadRepo();
      await trustFolder("claude");
      await trustFolder("codex");
      const started = await fleetIn(KINDS_DIR, "unused", "thread", "--title", "E2E greet", "--json", "--task",
        "Make greet() in greet.mjs return \"hello, fleet\". Done when `node check.mjs` prints ok. Keep the change to that function. Have the change reviewed by an agent of the reviewer role before you finish.");
      assert(started.code === 0, `fleet thread exited ${started.code}: ${started.err}${started.out}`);
      const lead = JSON.parse(started.out) as Run & { group: string; cwd: string; branch?: string; agent: string };
      try {
        assert(lead.branch === `fleet/${lead.id}` && lead.cwd === join(KINDS_DIR, ".herdr-fleet", "worktrees", lead.id), `not on a worktree of its own inside the repository: ${lead.cwd} ${lead.branch}`);
        const waited = await fleetIn(KINDS_DIR, lead.group, "wait", lead.id, "--timeout", String(THREAD_TIMEOUT_MS));
        const all = await runs(lead.group) as Array<Run & { agent: string }>;
        const done = all.find((run) => run.id === lead.id);
        const facts = factsOf(done, waited);
        assert(waited.code === 0, `the lead's turn exited ${waited.code}; ${facts}`);
        const check = Bun.spawnSync(["node", "check.mjs"], { cwd: lead.cwd, stdout: "pipe", stderr: "pipe" });
        assert(check.exitCode === 0, `node check.mjs fails in the worktree: ${check.stderr.toString()}; ${facts}`);
        assert(Bun.spawnSync(["node", "check.mjs"], { cwd: KINDS_DIR }).exitCode !== 0, "the main checkout changed: the lead did not stay on its worktree");
        const reviewers = all.filter((run) => run.role === "reviewer");
        assert(reviewers.length && reviewers.every((run) => run.agent !== done?.agent), `no review on another CLI than the lead's ${done?.agent}: ${JSON.stringify(all.map((run) => [run.role, run.agent]))}`);
        const contract = Bun.file(join(STATE_DIR, "fleet-results", lead.id, "contract.md"));
        assert(await contract.exists(), `the lead wrote no contract.md; ${facts}`);
        const text = await contract.text();
        assert(/- \[x\]/.test(text) && !/- \[ \]/.test(text) && !/- \[!\]/.test(text), `the contract is not met: ${text}`);
        assert(/\bPASS\b/.test(done?.result ?? "") && /Contract:/i.test(done?.result ?? ""), `the HANDOFF opens with no PASS line or leaves out the contract: ${JSON.stringify(done?.result)}`);
        console.log(`thread contract:\n${text.trim()}`);
      } finally {
        for (const run of await runs(lead.group).catch(() => [])) await herdrRpc("pane.close", { pane_id: run.paneId }, socket).catch(() => undefined);
        Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-C", KINDS_DIR, "worktree", "remove", "--force", lead.cwd]);
        Bun.spawnSync(["git", "-C", KINDS_DIR, "branch", "-D", `fleet/${lead.id}`]);
      }
    },
  });
}

if (KINDS.includes("claude") && KINDS.includes("codex")) {
  scenarios.push({
    name: "a project's coordinator starts a thread, edits nothing itself, is given the thread's question for the person, and passes the person's answer on",
    async run() {
      threadRepo();
      await trustFolder("claude");
      await trustFolder("codex");
      const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-C", KINDS_DIR, ...args], { stdout: "pipe", stderr: "pipe" });
      const coordinatorRun = async () => (await runs(coordinator.group)).find((run) => run.id === coordinator.id);
      /** the coordinator's next turn, which the fleet or the person started: until it settles */
      const nextTurn = async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && (await coordinatorRun())?.state !== "working") await Bun.sleep(500);
        const waited = await fleetIn(KINDS_DIR, coordinator.group, "wait", coordinator.id, "--timeout", String(TIMEOUT_MS));
        const run = await coordinatorRun();
        assert(waited.code === 0, `the coordinator's turn exited ${waited.code}; ${factsOf(run, waited)}`);
        return run;
      };
      const thread = async () => {
        const listed = JSON.parse((await fleetIn(KINDS_DIR, coordinator.group, "threads", "--json")).out) as Array<{ run: Run & { group: string; cwd: string; owner?: string; notice?: string }; state: string; status?: string }>;
        return listed.find((summary) => summary.run.owner === coordinator.id);
      };
      const started = await fleetIn(KINDS_DIR, "unused", "project", "--json", "--task",
        "Start a thread that changes what greet() in greet.mjs returns. Which greeting it returns is mine to decide, and I have not decided yet: \"hello, fleet\" or \"hi, fleet\". The thread's lead must ask me through you before it changes anything, not pick one. Once decided, it is done when `node check.mjs` prints ok, the change is kept to that function, and an agent of the reviewer role reviewed it.");
      assert(started.code === 0, `fleet project exited ${started.code}: ${started.err}${started.out}`);
      const coordinator = JSON.parse(started.out) as Run & { group: string; cwd: string; agent: string; project?: string };
      const threadGroups = new Set<string>();
      let lead: (Run & { group: string; cwd: string; owner?: string }) | undefined;
      try {
        assert(coordinator.role === "coordinator" && coordinator.agent === "claude" && coordinator.cwd === KINDS_DIR && coordinator.project === KINDS_DIR,
          `not a claude coordinator on the main checkout: ${JSON.stringify(coordinator)}`);
        const first = await fleetIn(KINDS_DIR, coordinator.group, "wait", coordinator.id, "--timeout", String(TIMEOUT_MS));
        const firstFacts = factsOf(await coordinatorRun(), first);
        assert(first.code === 0, `the coordinator's first turn exited ${first.code}; ${firstFacts}`);
        lead = (await thread())?.run;
        assert(lead, `the coordinator started no thread of its own; ${firstFacts}`);
        threadGroups.add(lead.group);
        assert(git("diff", "--quiet").exitCode === 0, `the coordinator changed the main checkout: ${git("diff", "--stat").stdout.toString()}`);
        const asked = await fleetIn(KINDS_DIR, lead.group, "wait", lead.id, "--timeout", String(THREAD_TIMEOUT_MS));
        assert(asked.code === 0, `the thread's first turn exited ${asked.code}; ${factsOf((await runs(lead.group)).find((run) => run.id === lead!.id), asked)}`);
        const waiting = await thread();
        assert(waiting?.state === "waiting" && waiting.status?.startsWith("BLOCKED"), `the thread does not wait on the person with a BLOCKED HANDOFF: ${JSON.stringify(waiting)}`);
        // the question goes to the coordinator by itself, which takes a turn on it
        const told = await nextTurn();
        const facts = factsOf(told, { out: "", err: "" });
        assert(/\[fleet\] Threads ask the person/.test(told?.lastOutput ?? ""), `the coordinator was not given the thread's question; ${facts}`);
        assert(!(await thread())?.run.notice, "the question is still waiting for the coordinator");
        console.log(`coordinator's question:\n${(told?.lastOutput ?? "").trim()}`);
        // the person answers the coordinator, which passes it on to the thread
        const answered = await fleetIn(KINDS_DIR, "unused", "project", "--task", "\"hello, fleet\".");
        assert(answered.code === 0, `fleet project exited ${answered.code}: ${answered.err}${answered.out}`);
        await nextTurn();
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && (await runs(lead.group)).find((run) => run.id === lead!.id)?.state !== "working") await Bun.sleep(1000);
        const done = await fleetIn(KINDS_DIR, lead.group, "wait", lead.id, "--timeout", String(THREAD_TIMEOUT_MS));
        assert(done.code === 0, `the thread's second turn exited ${done.code}; ${factsOf((await runs(lead.group)).find((run) => run.id === lead!.id), done)}`);
        assert(Bun.spawnSync(["node", "check.mjs"], { cwd: lead.cwd }).exitCode === 0, "node check.mjs fails in the thread's worktree");
        const review = await thread();
        assert(review?.state === "review", `the thread is not ready for review: ${JSON.stringify(review)}`);
        // a PASS reaches the person on the thread list, and does not wake the coordinator
        await Bun.sleep(15_000);
        assert((await coordinatorRun())?.state !== "working" && !review.run.notice, "the coordinator was woken for a PASS");
        assert(git("diff", "--quiet").exitCode === 0, "the main checkout changed during the run");
      } finally {
        for (const group of [coordinator.group, ...threadGroups]) {
          for (const run of await runs(group).catch(() => [])) await herdrRpc("pane.close", { pane_id: run.paneId }, socket).catch(() => undefined);
        }
        if (lead) {
          git("worktree", "remove", "--force", lead.cwd);
          git("branch", "-D", `fleet/${lead.id}`);
        }
      }
    },
  });
}

// every scenario costs model calls: FLEET_E2E_ONLY (words, comma-separated) runs the ones whose names hold one
const ONLY = (process.env["FLEET_E2E_ONLY"] ?? "").toLowerCase().split(",").map((word) => word.trim()).filter(Boolean);
const picked = ONLY.length ? scenarios.filter((scenario) => ONLY.some((word) => scenario.name.toLowerCase().includes(word))) : scenarios;

let failures = 0;
try {
  for (const [index, scenario] of picked.entries()) {
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
console.log(failures ? `${failures} of ${picked.length} scenarios failed` : `all ${picked.length} scenarios passed`);
process.exit(failures ? 1 : 0);
