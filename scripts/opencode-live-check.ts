/**
 * Runs the config and the guard plugin the fleet gives an OpenCode 2 pane through the real `opencode`, with no
 * model: not part of the unit suite (it starts servers, and needs OpenCode 2 on PATH as `opencode`, or OPENCODE_BIN).
 *
 *   bun scripts/opencode-live-check.ts
 *
 * What it does, per role: an isolated HOME and XDG_* (a temp folder, no credentials, no HERDR_*, self-update off), then
 * `opencode serve` with OPENCODE_SIMULATE=1 OPENCODE_DRIVE=1: every HTTP request of the server is answered by this
 * script over a local websocket (127.0.0.1:40950), so nothing leaves the machine and the "model" is a list of tool calls.
 * Each call goes through OpenCode's real permission rules, its shell parser and its plugins, and the script reads
 * the result the next request carries. It checks who stopped each call (the guard plugin, the rules, or nobody) and
 * what the call left behind (a file, a marker of a program git ran). It never touches the person's background service
 * (it uses its own port and HOME), and kills only the servers it started. Exit code 1 when a case differs.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeAdapter } from "../server/fleet/adapters.ts";

const BIN = process.env["OPENCODE_BIN"] ?? "opencode";
const BACKEND = "ws://127.0.0.1:40950";
const root = mkdtempSync(join(tmpdir(), "fleet-opencode-live-"));
const dirs = Object.fromEntries(["home", "config", "data", "state", "cache"].map((name) => [name, join(root, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const repo = join(root, "repo");
const remote = join(root, "remote.git");
const results = join(root, "results", "r1");
const marks = join(root, "marks");
mkdirSync(results, { recursive: true });
mkdirSync(marks, { recursive: true });
const FLEET = "/usr/bin/echo fleet";

const sh = (command: string, cwd = root) => {
  const run = Bun.spawnSync(["sh", "-c", command], { cwd, env: { PATH: process.env["PATH"]!, HOME: dirs["home"]! }, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`${command}: ${run.stderr}`);
};
// a repository whose own config names a program for git to run (fsmonitor), and a remote to push to
writeFileSync(join(root, "fsmonitor.sh"), `#!/bin/sh\necho ran >> ${marks}/fsmonitor\nexit 0\n`);
chmodSync(join(root, "fsmonitor.sh"), 0o755);
sh(`git init -q --bare ${remote} && git init -q ${repo}`);
sh(`git config user.email t@example.com && git config user.name t && echo one > a.txt && git add a.txt && git commit -qm one && git branch -M main && git remote add origin ${remote} && git push -q -u origin main && echo two >> a.txt && git commit -qam two && git config core.fsmonitor ${root}/fsmonitor.sh`, repo);
writeFileSync(join(root, "outside.txt"), "SECRET=1\n");

type Expect = "guard" | "rules" | "ran";
type Call = { command?: string; tool?: string; input?: unknown; expect: Expect; /** a file that must (true) or must not (false) exist after the call */ file?: [string, boolean]; contains?: string };
const shell = (command: string, expect: Expect, extra: Partial<Call> = {}): Call => ({ command, expect, ...extra });

const readOnlyCases: Call[] = [
  shell("pwd", "ran"), // the first request is the session title's, answered with this call and ignored
  shell("pwd", "ran"),
  shell("git status", "ran", { file: [join(marks, "fsmonitor"), false] }), // the pane's GIT_CONFIG_* beats the repository's core.fsmonitor
  shell("git diff --no-ext-diff --no-textconv HEAD~1", "ran", { contains: "two" }),
  shell(`export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch ${marks}/PWN_FSM #"; git status`, "guard", { file: [join(marks, "PWN_FSM"), false] }),
  shell(`X='$(touch ${marks}/PWN_AT_P)'; export Y=\${X@P}`, "guard", { file: [join(marks, "PWN_AT_P"), false] }),
  shell("x=1", "guard"),
  shell(`> ${marks}/PWN_BARE`, "guard", { file: [join(marks, "PWN_BARE"), false] }),
  shell(`>> ${marks}/PWN_APPEND`, "guard", { file: [join(marks, "PWN_APPEND"), false] }),
  shell(`ls > ${marks}/PWN_LS`, "guard", { file: [join(marks, "PWN_LS"), false] }),
  shell(`git diff --no-ext-diff --no-textconv /dev/null ${root}/outside.txt`, "guard"), // an implicit --no-index
  shell(`git show --no-ext-diff --no-textconv HEAD:.env`, "guard"),
  shell(`git diff --no-ext-diff --no-textconv --ex""t-diff`, "guard"),
  shell("rm -rf nothing", "guard"),
  shell(`${FLEET} send lead "a -> b, Map<K,V>"`, "ran", { contains: "a -> b, Map<K,V>" }),
  shell(`${FLEET} send lead 'x'; touch ${marks}/PWN_SEP`, "guard", { file: [join(marks, "PWN_SEP"), false] }),
  shell("git merge --abort", "guard"), // not the coordinator
  { tool: "write", input: { path: join(results, "handoff.md"), content: "HANDOFF\nPASS\n" }, expect: "ran", file: [join(results, "handoff.md"), true] },
  { tool: "write", input: { path: join(repo, "NOT_ALLOWED.txt"), content: "x" }, expect: "rules", file: [join(repo, "NOT_ALLOWED.txt"), false] },
  { tool: "read", input: { path: join(root, "outside.txt") }, expect: "rules" },
  { tool: "webfetch", input: { url: "https://example.com" }, expect: "ran", contains: "No tool named" },
];
// the same agent without the plugin: what the permission rules alone decide (the second layer)
const rulesOnlyCases: Call[] = [
  shell("pwd", "ran"),
  shell("pwd", "ran"),
  shell("rm -rf nothing", "rules"),
  shell("ls; rm -rf nothing", "rules"),
  shell(`git diff --no-ext-diff --no-textconv /dev/null ${root}/outside.txt`, "rules"),
  shell(`git diff --no-ext-diff --no-textconv --ex""t-diff`, "rules"),
  shell(`ls > ${marks}/PWN_RULE`, "rules", { file: [join(marks, "PWN_RULE"), false] }),
  shell("git diff --no-ext-diff --no-textconv HEAD~1", "ran"),
  // the gap the plugin closes: no command node, so no permission check
  shell(`> ${marks}/GAP_BARE`, "ran", { file: [join(marks, "GAP_BARE"), true] }),
  shell(`export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch ${marks}/GAP_FSM #"; git status`, "ran", { file: [join(marks, "GAP_FSM"), true] }),
];
const coordinatorCases: Call[] = [
  shell("pwd", "ran"),
  shell("pwd", "ran"),
  shell("git merge --abort", "ran"), // git's own answer: no merge to abort
  shell("git merge --no-ff fleet/ab12cd", "ran"), // git's own answer: not something we can merge
  shell("git pull --ff-only", "ran"),
  shell("gh pr merge 12 --merge", "ran"), // gh's own answer: not signed in
  shell("gh pr merge 12 --merge --admin", "guard"),
  shell("gh pr merge main --merge", "guard"),
  shell("git merge --no-ff fleet/x main", "guard"),
  shell("git merge --no-ff fleet/x -F /etc/passwd", "guard"),
  shell("git push origin main", "guard"),
  shell(`git merge --no-ff fleet/x > ${marks}/PWN_MERGE`, "guard", { file: [join(marks, "PWN_MERGE"), false] }),
];
const editorCases: Call[] = [
  shell("pwd", "ran"),
  shell("pwd", "ran"),
  shell("git status", "ran", { file: [join(marks, "fsmonitor"), false] }),
  { tool: "write", input: { path: "inside.txt", content: "ok" }, expect: "ran", file: [join(repo, "inside.txt"), true] },
  { tool: "write", input: { path: join(root, "outside-edit.txt"), content: "no" }, expect: "rules", file: [join(root, "outside-edit.txt"), false] },
  { tool: "write", input: { path: "../sibling.txt", content: "no" }, expect: "rules" },
  { tool: "write", input: { path: join(results, "handoff2.md"), content: "ok" }, expect: "ran", file: [join(results, "handoff2.md"), true] },
  ...["git push --force origin main", "git push -f origin main", "git push -vuf origin main", "git push -uvf origin main", "git push --mir", "git push --delete origin main", "git push -d origin main", "git push origin :main",
    "git push origin +main", `git -C ${repo} push --force-with-lease origin main`, "git push --prune origin"].map((command) => shell(command, "rules")),
  shell("git push origin main", "ran", { contains: "main -> main" }),
  shell("git push -u origin main", "ran"),
  shell(`echo run > ran.txt && cat ran.txt`, "ran", { contains: "run" }), // an editing role's shell is open
];

const cases: Array<{ name: string; role: "readonly" | "coordinator" | "editor"; agent: string; plugin: boolean; calls: Call[] }> = [
  { name: "role that edits nothing", role: "readonly", agent: "fleet-readonly", plugin: true, calls: readOnlyCases },
  { name: "same agent, permission rules alone", role: "readonly", agent: "fleet-readonly", plugin: false, calls: rulesOnlyCases },
  { name: "coordinator", role: "coordinator", agent: "fleet-readonly", plugin: true, calls: coordinatorCases },
  { name: "role that edits", role: "editor", agent: "build", plugin: true, calls: editorCases },
];

function configFor(role: "readonly" | "coordinator" | "editor", plugin: boolean) {
  const env = opencodeAdapter.env!({ resultDir: results, fleetCommand: FLEET, model: "simp/sim-1", readOnly: role !== "editor", merges: role === "coordinator" });
  const config = JSON.parse(env["OPENCODE_CONFIG_CONTENT"]!);
  // a provider the simulated network answers (its model is the script below)
  config.providers = { simp: { name: "Sim", env: ["SIM_KEY"], package: "@opencode/ai/providers/openai/chat", models: { "sim-1": { name: "Sim one" } } } };
  if (!plugin) delete config.plugins;
  return { env, config };
}

async function runCase(entry: (typeof cases)[number], port: number): Promise<number> {
  for (const file of ["fsmonitor", "PWN_FSM", "PWN_AT_P", "PWN_BARE", "PWN_APPEND", "PWN_LS", "PWN_SEP", "PWN_MERGE", "PWN_RULE", "GAP_BARE", "GAP_FSM"]) rmSync(join(marks, file), { force: true });
  for (const file of ["inside.txt", "NOT_ALLOWED.txt"]) rmSync(join(repo, file), { force: true });
  const { env: paneEnv, config } = configFor(entry.role, entry.plugin);
  const server = Bun.spawn([BIN, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repo, stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env["PATH"]!, LANG: "C.UTF-8", HOME: dirs["home"]!, XDG_CONFIG_HOME: dirs["config"]!, XDG_DATA_HOME: dirs["data"]!, XDG_STATE_HOME: dirs["state"]!, XDG_CACHE_HOME: dirs["cache"]!,
      OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_SIMULATE: "1", OPENCODE_DRIVE: "1", SIM_KEY: "not-a-key",
      // the pane's own environment, as the fleet gives it (the git config), and the config with the simulated provider
      GIT_CONFIG_COUNT: paneEnv["GIT_CONFIG_COUNT"]!, GIT_CONFIG_KEY_0: paneEnv["GIT_CONFIG_KEY_0"]!, GIT_CONFIG_VALUE_0: paneEnv["GIT_CONFIG_VALUE_0"]!,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
  });
  let failed = 0;
  try {
    const password = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the server did not start")), 20_000);
      (async () => {
        const decoder = new TextDecoder();
        let seen = "";
        const reader = server.stdout.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          seen += decoder.decode(value);
          const found = /server password (\S+)/.exec(seen);
          if (found) { clearTimeout(timer); resolve(found[1]!); return; }
        }
      })().catch(reject);
    });
    const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" };
    const api = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (response) => ({ status: response.status, text: await response.text() }));
    // the first calls of a session load its plugins and rules asynchronously
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const ws = new WebSocket(BACKEND);
    let nextId = 1;
    const pending = new Map<number, (value: unknown) => void>();
    const rpc = (method: string, params?: unknown) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
    let index = 0;
    let previous: Call | undefined;
    const outcomes: Array<{ call: Call; result: string }> = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    ws.onmessage = async (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)!(message.result ?? message.error); pending.delete(message.id); return; }
      if (message.method !== "llm.request") return;
      const { id, body } = message.params as { id: string; body: { messages?: Array<{ role: string; content: unknown }> } };
      const last = body.messages?.at(-1);
      if (previous && last?.role === "tool") outcomes.push({ call: previous, result: typeof last.content === "string" ? last.content : JSON.stringify(last.content) });
      const call = entry.calls[index++];
      previous = call;
      if (!call) { await rpc("llm.chunk", { id, items: [{ type: "textDelta", text: "done" }] }); await rpc("llm.finish", { id, reason: "stop" }); finish(); return; }
      await rpc("llm.chunk", { id, items: [{ type: "toolCall", index: 0, id: `call_${index}`, name: call.tool ?? "shell", input: call.input ?? { command: call.command } }] });
      await rpc("llm.finish", { id, reason: "tool-calls" });
    };
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
    await rpc("simulation.handshake", { client: { name: "fleet-live-check", version: "0" }, expectedRole: "backend", offeredVersions: [1], requiredCapabilities: [], optionalCapabilities: [] });
    await rpc("llm.attach");
    const created = JSON.parse((await api("POST", "/api/session", { agent: entry.agent, model: { providerID: "simp", id: "sim-1" }, location: { directory: repo } })).text) as { data: { id: string } };
    await api("POST", `/api/session/${created.data.id}/prompt`, { text: "go" });
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 90_000))]);
    ws.close();

    // outcomes[0] is the title's call; the rest follow the list
    const judged = entry.calls.slice(1);
    console.log(`\n${entry.name} (${entry.role}, agent ${entry.agent}${entry.plugin ? "" : ", no plugin"}): ${outcomes.length} results of ${entry.calls.length} calls`);
    for (const [at, call] of judged.entries()) {
      const outcome = outcomes[at];
      const result = outcome?.result ?? "(no result)";
      const by: Expect = result.includes("herdr-fleet:") ? "guard" : result.includes("permission.rejected") ? "rules" : "ran";
      const problems: string[] = [];
      if (!outcome) problems.push("no result");
      else if (by !== call.expect) problems.push(`stopped by ${by}, expected ${call.expect}`);
      if (call.contains && !result.includes(call.contains)) problems.push(`result lacks ${JSON.stringify(call.contains)}`);
      if (call.file && existsSync(call.file[0]) !== call.file[1]) problems.push(`${call.file[0]} ${call.file[1] ? "missing" : "exists"}`);
      if (problems.length) { failed++; console.log(`  FAIL ${call.command ?? `${call.tool} ${JSON.stringify(call.input)}`}\n       ${problems.join("; ")}\n       ${result.slice(0, 160).replaceAll("\n", " ")}`); }
      else console.log(`  ok   [${by}] ${call.command ?? call.tool}`);
    }
  } finally {
    server.kill();
    await server.exited;
  }
  return failed;
}

let failures = 0;
try {
  if (Bun.spawnSync([BIN, "--version"], { stdout: "pipe" }).stdout.toString().trim().match(/v?(\d+)\./)?.[1] !== "2") throw new Error(`${BIN} is not OpenCode 2`);
  for (const [at, entry] of cases.entries()) failures += await runCase(entry, 45920 + at);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} case(s) differ` : "\nall cases as expected");
process.exit(failures ? 1 : 0);
