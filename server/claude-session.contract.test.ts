// black-box: scripts/contract/launch.ts
import { afterAll, beforeAll, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchServer, type LaunchedServer } from "../scripts/contract/launch.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Real foreground processes and native PID records, without hooks or a model request.
const root = mkdtempSync(join(tmpdir(), "herdr-claude-session-"));
const NATIVE = process.platform === "linux" || process.platform === "darwin";
const workspaces: string[] = [];
const FIRST = "8d8f7d39-6788-49f3-b071-e3ba985c163c";
const SECOND = "f2f55dc4-50ad-478c-a641-bf21268a1bba";
const NEXT = "9343d82a-890c-4a39-a4a7-33c017d496f1";
const UNWRITTEN = "5b0c7f1e-3d2a-4c8b-9e6f-0a1b2c3d4e5f";
/**
 * Claude Code's name for the project folder of the directory it started in (read from Claude Code
 * 2.1.284): every character that is not an ASCII letter or digit becomes `-`, and a name longer than
 * 200 characters keeps its first 200, then `-` and the base-36 Java String.hashCode of the whole path.
 */
function claudeProjectDir(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (hash << 5) - hash + cwd.charCodeAt(i) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
const project = join(root, ".claude", "projects", claudeProjectDir(root));
/** a server whose HOME is the test's folder: Claude's default store is `<root>/.claude` */
const launch = (configDir?: string) =>
  launchServer({ env: { HOST: "127.0.0.1", HERDR_FLEET_TOKEN: "", HOME: root, ...(configDir !== undefined && { CLAUDE_CONFIG_DIR: configDir }) } });
let server: LaunchedServer | undefined;
let first: { pane: string; pid: number };
let second: { pane: string; pid: number };

function transcript(id: string, store = join(root, ".claude"), answer = `Answer ${id}`): void {
  const folder = join(store, "projects", claudeProjectDir(root));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.jsonl`), [
    { type: "user", message: { content: `Prompt ${id}` } },
    { type: "assistant", message: { content: [{ type: "text", text: answer }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
}

async function pane(id: string, configDir?: string): Promise<{ pane: string; pid: number }> {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-claude-session" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  let ready: (pid: number) => void = () => {};
  const signal = new Promise<number>((resolve) => { ready = resolve; });
  const listener = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { data(socket, data) { ready(Number(data.toString())); socket.end(); } },
  });
  const node = configDir ? join(root, "claude") : Bun.which("node");
  if (!node) throw new Error("Claude session contract needs Node");
  const timeout = setTimeout(() => ready(0), 10_000);
  try {
    await herdrRpc("pane.send_text", {
      pane_id: paneId, text: `exec env ${configDir ? `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)}` : "-u CLAUDE_CONFIG_DIR"} ${JSON.stringify(node)} ${JSON.stringify(join(root, "claude.cjs"))} ${JSON.stringify(root)} ${id} ${listener.port}\n`,
    });
    const pid = await signal;
    if (!pid) throw new Error("Claude stand-in did not signal readiness");
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    return { pane: paneId, pid };
  } finally { clearTimeout(timeout); listener.stop(true); }
}

beforeAll(async () => {
  if (!NATIVE) return;
  const node = Bun.which("node");
  if (!node) throw new Error("Claude session contract needs Node");
  // A native executable keeps its environment visible on macOS. Node's process.title setter
  // erases the environment that ps can see there, so use the renamed executable for that case.
  // Bun is self-contained on macOS; a copied Homebrew Node needs its original dylib location.
  copyFileSync(process.platform === "darwin" ? process.execPath : node, join(root, "claude"));
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, ".claude", "sessions"), { recursive: true });
  for (const id of [FIRST, SECOND, NEXT]) transcript(id);
  writeFileSync(join(root, "claude.cjs"), `
const fs = require("node:fs");
const net = require("node:net");
const [home, sessionId, port] = process.argv.slice(2);
if (process.platform === "linux" || !process.env.CLAUDE_CONFIG_DIR) process.title = "claude";
const procStart = process.platform === "linux"
  ? fs.readFileSync("/proc/self/stat", "utf8").split(") ").pop().split(" ")[19]
  : require("node:child_process").execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, TZ: "UTC" }, encoding: "utf8" }).trim();
const store = process.env.CLAUDE_CONFIG_DIR || home + "/.claude";
fs.mkdirSync(store + "/sessions", { recursive: true });
fs.writeFileSync(store + "/sessions/" + process.pid + ".json", JSON.stringify({
  pid: process.pid, sessionId, cwd: home, procStart, kind: "interactive",
}));
net.connect(Number(port), "127.0.0.1", function () { this.end(String(process.pid)); });
process.stdin.resume();
`);
  first = await pane(FIRST);
  second = await pane(SECOND);
  server = await launch();
});

afterAll(async () => {
  await server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
});

async function read(paneId: string, from = server!): Promise<ConversationResponse> {
  const response = await fetch(`${from.url}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return await response.json();
}

it.skipIf(!NATIVE)("reads each hookless Claude pane's own conversation in a shared cwd", async () => {
  // The pane has no session id from Herdr; cwd and recency cannot distinguish these.
  const info = await herdrRpc<{ agent: { agent_session?: unknown } }>("agent.get", { target: first.pane });
  expect(info.agent.agent_session).toBeUndefined();
  const a = await read(first.pane);
  const b = await read(second.pane);
  expect(a.source).toBe("claude-transcript");
  expect(a.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${FIRST}` });
  expect(b.source).toBe("claude-transcript");
  expect(b.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${SECOND}` });
});

it.skipIf(!NATIVE || process.getuid === undefined)("opens a relative link into the pane's Claude session folder, and only that session's", async () => {
  // Claude Code's own temp base for this user: only the test's project folder is made in it, and removed
  const base = join(tmpdir(), `claude-${process.getuid!()}`);
  const madeBase = !existsSync(base);
  const projectTemp = join(base, claudeProjectDir(root));
  mkdirSync(join(projectTemp, FIRST, "scratchpad"), { recursive: true });
  writeFileSync(join(projectTemp, FIRST, "scratchpad", "notes.md"), "scratch notes");
  const file = (paneId: string, path: string) =>
    fetch(`${server!.url}/api/fs/file?pane_id=${encodeURIComponent(paneId)}&path=${encodeURIComponent(path)}`);
  try {
    const found = await file(first.pane, "scratchpad/notes.md");
    expect(found.status).toBe(200);
    expect(await found.text()).toBe("scratch notes");
    // a bare name is found under the folder too
    expect(await (await file(first.pane, "notes.md")).text()).toBe("scratch notes");
    // the other pane's session keeps no such folder
    expect((await file(second.pane, "scratchpad/notes.md")).status).toBe(404);
    expect((await file(first.pane, "scratchpad/missing.md")).status).toBe(404);
  } finally {
    rmSync(projectTemp, { recursive: true, force: true });
    if (madeBase) rmSync(base, { recursive: true, force: true });
  }
});

it.skipIf(!NATIVE)("follows the current PID record without retaining a previous session", async () => {
  const path = join(root, ".claude", "sessions", `${first.pid}.json`);
  const previous = readFileSync(path, "utf8");
  try {
    const record = JSON.parse(previous);
    writeFileSync(path, JSON.stringify({ ...record, sessionId: NEXT }));
    const response = await read(first.pane);
    expect(response.source).toBe("claude-transcript");
    expect(response.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${NEXT}` });
  } finally { writeFileSync(path, previous); }
});

it.skipIf(!NATIVE)("refuses a reused PID record rather than selecting another same-cwd session", async () => {
  const path = join(root, ".claude", "sessions", `${first.pid}.json`);
  const previous = readFileSync(path, "utf8");
  try {
    writeFileSync(path, JSON.stringify({ ...JSON.parse(previous), procStart: "1" }));
    expect(await read(first.pane)).toEqual({ source: "scrollback", turns: [] });
  } finally { writeFileSync(path, previous); }
});

it.skipIf(!NATIVE)("answers a session Claude has not written yet as an empty conversation, then follows the file it writes", async () => {
  const fresh = await pane(UNWRITTEN);
  const blank = await read(fresh.pane);
  expect(blank).toMatchObject({ source: "claude-transcript", turns: [], cursor: null, history_id: `unwritten:${UNWRITTEN}` });
  transcript(UNWRITTEN);
  const written = await read(fresh.pane);
  expect(written.source).toBe("claude-transcript");
  expect(written.history_id).not.toBe(`unwritten:${UNWRITTEN}`);
  expect(written.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${UNWRITTEN}` });
  rmSync(join(project, `${UNWRITTEN}.jsonl`));
  expect(await read(fresh.pane)).toEqual({ source: "scrollback", turns: [] });
});

it.skipIf(!NATIVE)("keeps the existing Herdr hook path when no native PID record is available", async () => {
  const hooked = await pane(SECOND);
  rmSync(join(root, ".claude", "sessions", `${hooked.pid}.json`));
  await herdrRpc("pane.report_agent_session", {
    pane_id: hooked.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
  });
  const response = await read(hooked.pane);
  expect(response.source).toBe("claude-transcript");
  expect(response.turns.at(-1)?.parts[0]).toMatchObject({ text: `Answer ${FIRST}` });
});

it.skipIf(!NATIVE)("uses each process's config dir before the server's store, with and without a hook", async () => {
  const ownStore = join(root, "environment with spaces", ".claude");
  const serverStore = join(root, "server-store");
  // Same session id and cwd in all stores: only the process environment selects the right one.
  transcript(FIRST, ownStore, "Pane's own answer");
  transcript(FIRST, serverStore, "Server's other answer");
  const custom = await pane(FIRST, ownStore);
  // a server started with CLAUDE_CONFIG_DIR pointing at its own store
  const withStore = await launch(serverStore);
  try {
    const native = await read(custom.pane, withStore);
    expect(native.source).toBe("claude-transcript");
    expect(native.turns.at(-1)?.parts[0]).toMatchObject({ text: "Pane's own answer" });
    rmSync(join(ownStore, "sessions", `${custom.pid}.json`));
    await herdrRpc("pane.report_agent_session", {
      pane_id: custom.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
    });
    expect((await read(custom.pane, withStore)).turns.at(-1)?.parts[0]).toMatchObject({ text: "Pane's own answer" });
    // A process without the variable retains the server-level fallback.
    const fallback = await pane(FIRST);
    await herdrRpc("pane.report_agent_session", {
      pane_id: fallback.pane, source: "herdr:claude", agent: "claude", seq: 1, agent_session_id: FIRST,
    });
    expect((await read(fallback.pane, withStore)).turns.at(-1)?.parts[0]).toMatchObject({ text: "Server's other answer" });
  } finally { await withStore.stop(); }
});
