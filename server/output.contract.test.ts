// black-box: scripts/contract/launch.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, paneSendText, paneSendKeys } from "./herdr/client.ts";
import { launchServer, type LaunchedServer, type LaunchSpec } from "../scripts/contract/launch.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/**
 * Each server is started by scripts/contract/launch.ts and reached through its URL only (ADR 0122);
 * what needs the server in this process is in server/output.herdr.test.ts.
 *
 * The output window a client gets (the contract's values, written here rather than read from the
 * server under test): output pauses once a client has `OUTPUT_HIGH_BYTES` unacknowledged, a client
 * that stays silent past `OUTPUT_STALL_MS` is closed, and it is never sent more than `OUTPUT_HARD_BYTES`.
 */
const OUTPUT_HIGH_BYTES = 256 * 1024;
const OUTPUT_HARD_BYTES = 1024 * 1024;
const OUTPUT_STALL_MS = 2000;

/** the herdr the tests use; a server under test is given a shim in front of it, or a path to it */
const REAL_HERDR = Bun.which(process.env["HERDR_FLEET_HERDR_BIN"] || "herdr") ?? "herdr";

const root = mkdtempSync(join(tmpdir(), "herdr-output-contract-"));
let server: LaunchedServer;
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
beforeAll(async () => {
  mkdirSync(zshStartup);
  writeFileSync(join(zshStartup, ".zshrc"), "");
  server = await launchServer({ env: { HERDR_FLEET_TOKEN: "" } });
});
afterAll(async () => {
  for (const socket of sockets) socket.close();
  try {
    await server?.stop();
  } finally {
    for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
    rmSync(root, { recursive: true, force: true });
  }
});

const wsUrl = (target: LaunchedServer) => `${target.url.replace(/^http/, "ws")}/ws`;

/** a server of the test's own, stopped when `use` is done; a failing `use` is reported before a failing stop */
async function withServer<T>(spec: LaunchSpec, use: (launched: LaunchedServer) => Promise<T>): Promise<T> {
  const launched = await launchServer(spec);
  let result: T;
  try {
    result = await use(launched);
  } catch (error) {
    await launched.stop().catch(() => {});
    throw error;
  }
  await launched.stop();
  return result;
}

async function until(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

/**
 * Where the panes' zsh reads its startup files from (ZDOTDIR): these tests type commands into the
 * shell, and the person's own zsh files are no input of them. Those may hold every new shell back
 * before it reads a key, past the tests' deadlines: zsh-abbr's job queue in /tmp makes each new zsh
 * wait up to 30 s for a shell that was closed while it started, as the panes the tests close are
 * (#168). HOME stays the person's, for the programs the tests run. The empty .zshrc keeps zsh from
 * asking its new-user questions.
 */
const zshStartup = join(root, "zsh");

async function pane(): Promise<string> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "herdr-fleet-test-output", cwd: root, focus: false, env: { ZDOTDIR: zshStartup } },
  );
  workspaces.push(created.workspace.workspace_id);
  return created.root_pane.pane_id;
}

async function connect(paneId: string, ack = true, observer = false, target = server) {
  const ws = new WebSocket(wsUrl(target));
  sockets.push(ws);
  const state = {
    bytes: 0, frames: 0, ack, code: 0, exits: 0,
    latest: undefined as Extract<ServerMessage, { type: "pty-data" }> | undefined,
    errors: [] as string[], tail: "",
  };
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const acknowledge = (frame = state.latest) => {
    if (frame?.flow && ws.readyState === WebSocket.OPEN) send({ type: "pty-ack", pane_id: paneId, ...frame.flow });
  };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") state.errors.push(frame.code);
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type !== "pty-data" || frame.pane_id !== paneId) return;
    state.bytes += Buffer.byteLength(frame.data);
    state.frames++;
    state.latest = frame;
    state.tail = (state.tail + frame.data).slice(-8192);
    if (state.ack) acknowledge(frame);
  });
  ws.addEventListener("close", (event) => { state.code = event.code; });
  await until(() => ws.readyState === WebSocket.OPEN, "socket open");
  if (observer) send({ type: "role", mode: "observe" });
  send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
  await until(() => state.frames > 0, "initial terminal paint");
  return { ws, state, send, acknowledge };
}

/**
 * What the servers write to standard error from now on: the launcher hands it on to this
 * process's standard error (scripts/contract/launch.ts), where this reads it.
 */
function captureStderr(): { lines: () => string[]; restore: () => void } {
  let text = "";
  const decoder = new TextDecoder();
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    return (write as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  return { lines: () => text.split("\n"), restore: () => { process.stderr.write = write; } };
}

async function flood(paneId: string): Promise<void> {
  // Redraws reach the attach stream; raw shell byte rate alone is not its workload.
  await Bun.sleep(150); // herdr's attach consumes very early keystrokes
  await paneSendText(paneId, `python3 -u -c 'import sys,time; [(sys.stdout.write("\\033[H"+(str(i%10)*79+"\\n")*23),sys.stdout.flush(),time.sleep(.01)) for i in range(1500)]'`);
  await paneSendKeys(paneId, ["Enter"]);
}

describe("real terminal output flow control", () => {
  it("waits for the old attach to retire when a pane is reopened immediately", async () => {
    const paneId = await pane();
    const client = await connect(paneId);
    try {
      const old = client.state.latest!.flow!;
      client.send({ type: "detach", pane_id: paneId });
      client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
      await until(() => !!client.state.latest?.flow && client.state.latest.flow.stream_id !== old.stream_id, "fresh attach after retirement");
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: old.stream_id, offset: Number.MAX_SAFE_INTEGER });
      await Bun.sleep(100);
      expect(client.state.errors).toEqual([]);
      expect(client.state.exits).toBe(0);
      expect(client.state.code).toBe(0);
    } finally { client.ws.close(); }
  }, 20_000);

  it("bounds a stalled observer, releases the operator, and leaves the pane alive", async () => {
    const paneId = await pane();
    const operator = await connect(paneId);
    const observer = await connect(paneId, false, true);
    try {
      await flood(paneId);
      await until(() => observer.state.bytes >= OUTPUT_HIGH_BYTES, "observer high watermark", 15_000);
      const started = Date.now();
      await until(() => observer.state.code !== 0, "stalled observer closed", OUTPUT_STALL_MS + 3000);
      expect(observer.state.code).toBe(OUTPUT_STALLED_CLOSE_CODE);
      expect(observer.state.bytes).toBeLessThanOrEqual(OUTPUT_HARD_BYTES);
      expect(Date.now() - started).toBeLessThan(OUTPUT_STALL_MS + 2000);
      const received = operator.state.bytes;
      await until(() => operator.state.bytes > received + 4096, "operator output resumes");
      // Ctrl+C takes the actual WS input path while output is running.
      operator.send({ type: "input", pane_id: paneId, text: "\x03" });
      await Bun.sleep(200);
      operator.send({ type: "input", pane_id: paneId, text: "printf 'FLOW_%s\\n' ALIVE\r" });
      await until(() => operator.state.tail.includes("FLOW_ALIVE"), "pane survives observer eviction");
      expect(operator.state.code).toBe(0);
      expect(operator.state.errors).toEqual([]);
    } finally { operator.ws.close(); observer.ws.close(); }
  }, 35_000);

  it("gives a late joiner time to acknowledge its replay without pausing the operator", async () => {
    const paneId = await pane();
    const operator = await connect(paneId);
    let joiner: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await flood(paneId);
      // the replay tail is full: the joiner's first frame is ~128 KiB
      await until(() => operator.state.bytes >= 160 * 1024, "operator fills the replay tail", 15_000);
      // a phone on a slow link: it does not acknowledge its replay for longer than the stall deadline
      joiner = await connect(paneId, false);
      const joined = Date.now();
      expect(joiner.state.bytes).toBeGreaterThan(64 * 1024);
      await Bun.sleep(1000); // fixed wait: the joiner must stay silent past the time its window blocks
      const before = operator.state.bytes;
      await Bun.sleep(OUTPUT_STALL_MS); // fixed wait: proving nothing stalls or closes for a full stall deadline
      // the joiner held only its own window up: the shared pty kept streaming to the operator
      expect(operator.state.bytes - before).toBeGreaterThan(64 * 1024);
      expect(Date.now() - joined).toBeGreaterThan(OUTPUT_STALL_MS);
      expect(joiner.state.code).toBe(0);
      // its ACK arrives inside its budget and it carries on as an ordinary client
      joiner.state.ack = true;
      joiner.acknowledge();
      const caught = joiner.state.bytes;
      await until(() => joiner!.state.bytes > caught + 4096, "joiner keeps receiving");
      expect(joiner.state.code).toBe(0);
      expect(operator.state.code).toBe(0);
      operator.send({ type: "input", pane_id: paneId, text: "\x03" });
    } finally { operator.ws.close(); joiner?.ws.close(); }
  }, 30_000);

  it("resumes on valid ACKs and rejects future credit without accepting stale subscriptions", async () => {
    const paneId = await pane();
    const client = await connect(paneId, false);
    try {
      const initial = client.state.latest!;
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: initial.flow!.stream_id, offset: Number.MAX_SAFE_INTEGER });
      await until(() => client.state.errors.includes("invalid_ack"), "future ACK refused");
      await flood(paneId);
      await until(() => client.state.bytes >= OUTPUT_HIGH_BYTES, "pause at high watermark", 15_000);
      await Bun.sleep(200);
      const paused = client.state.bytes;
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: "previous-subscription", offset: paused });
      await Bun.sleep(200);
      expect(client.state.bytes).toBe(paused);
      client.state.ack = true;
      client.acknowledge();
      await until(() => client.state.bytes > paused + 4096, "valid credit resumes output");
      expect(client.state.code).toBe(0);
      client.send({ type: "input", pane_id: paneId, text: "\x03" });
    } finally { client.ws.close(); }
  }, 30_000);
});

describe("a herdr the server cannot start (#925)", () => {
  it("tells the attaching client and logs it, instead of a terminal that waits in silence", async () => {
    const paneId = await pane();
    // the server is given a herdr that is not there; the test puts it there afterwards
    const missing = join(root, "missing-herdr");
    await withServer({ env: { HERDR_FLEET_TOKEN: "", HERDR_FLEET_HERDR_BIN: missing } }, async (lost) => {
      const ws = new WebSocket(wsUrl(lost));
      sockets.push(ws);
      const errors: string[] = [];
      const errorPanes: (string | undefined)[] = [];
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        if (frame.type === "error") { errors.push(frame.code); errorPanes.push(frame.pane_id); }
      });
      await until(() => ws.readyState === WebSocket.OPEN, "socket open");
      const stderr = captureStderr();
      const named = () => stderr.lines().filter((line) => line.includes(paneId) && line.includes(missing));
      try {
        ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" } satisfies ClientMessage));
        await until(() => errors.includes("attach_failed"), "the missing herdr is reported", 3_000);
        // the log reaches this process through the launcher's pipe, a little after the client is told
        await until(() => named().length > 0, "the missing herdr is logged", 3_000);
      } finally {
        stderr.restore();
      }
      expect(errors).toEqual(["attach_failed"]);
      // the panes of a PC share one connection: the failure names its pane, so only that terminal ends
      expect(errorPanes).toEqual([paneId]);
      expect(named()).toHaveLength(1);
      // nothing was left behind: with herdr back, the pane attaches for real
      symlinkSync(REAL_HERDR, missing);
      const client = await connect(paneId, true, false, lost);
      try {
        expect(client.state.errors).toEqual([]);
      } finally { client.ws.close(); ws.close(); }
    });
  }, 30_000);
});

describe("an attach herdr refuses over a read in progress", () => {
  /**
   * A herdr that refuses the first `refusals` attaches as herdr 0.9 refuses one racing a
   * pane read of the same terminal, then attaches for real.
   */
  function refusingHerdr(refusals: number): { path: string; attempts: () => number } {
    const dir = mkdtempSync(join(root, "refusing-herdr-"));
    const count = join(dir, "count");
    const path = join(dir, "herdr");
    writeFileSync(path, [
      "#!/bin/sh",
      `n=$(cat '${count}' 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > '${count}'`,
      `if [ "$n" -lt ${refusals} ]; then printf 'herdr: server shut down: terminal attach failed: terminal term_0 has a read in progress; retry\\r\\n'; exit 1; fi`,
      `exec '${REAL_HERDR}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
    return { path, attempts: () => existsSync(count) ? Number(readFileSync(count, "utf8").trim() || 0) : 0 };
  }

  it("attaches again for the same client instead of ending its terminal", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(2);
    await withServer({ env: { HERDR_FLEET_TOKEN: "", HERDR_FLEET_HERDR_BIN: herdr.path } }, async (bridge) => {
      const client = await connect(paneId, true, false, bridge);
      try {
        // the refusals are retried; the third attach is real and paints the pane
        await until(() => herdr.attempts() === 3 && client.state.tail.includes("\x1b[?1049h"), "the third attach paints");
        await Bun.sleep(300); // herdr's attach consumes very early keystrokes
        client.send({ type: "input", pane_id: paneId, text: "echo attach-$((6*7))\r" });
        await until(() => client.state.tail.includes("attach-42"), "the retried attach streams the pane");
        expect(herdr.attempts()).toBe(3);
        expect(client.state.exits).toBe(0);
        expect(client.state.errors).toEqual([]);
        // a refused attach's setup, teardown and message never reached the terminal
        expect(client.state.tail).not.toContain("read in progress");
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("still ends the terminal when herdr keeps refusing past the longest such read", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(1000);
    await withServer({ env: { HERDR_FLEET_TOKEN: "", HERDR_FLEET_HERDR_BIN: herdr.path }, test: { attachRetryForMs: 800 } }, async (impatient) => {
      const ws = new WebSocket(wsUrl(impatient));
      sockets.push(ws);
      let exits = 0; let tail = "";
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        if (frame.type === "pty-exit" && frame.pane_id === paneId) exits++;
        if (frame.type === "pty-data" && frame.pane_id === paneId) tail += frame.data;
      });
      await until(() => ws.readyState === WebSocket.OPEN, "socket open");
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 } satisfies ClientMessage));
      await until(() => exits === 1, "pty-exit once the retries run out");
      expect(herdr.attempts()).toBeGreaterThan(2);
      // the last refusal is shown: it says why the terminal ended
      expect(tail).toContain("read in progress");
      ws.close();
    });
  }, 30_000);
});

describe("herdr's attach-time terminal queries", () => {
  it("answers them in the bridge and keeps them out of every client's terminal", async () => {
    const dir = mkdtempSync(join(root, "probing-herdr-"));
    const replies = join(dir, "replies");
    const path = join(dir, "herdr");
    // herdr 0.9.4+ asks its terminal these before it attaches; the herdr CI pins does not, so a shim asks
    writeFileSync(path, [
      "#!/bin/sh",
      "saved=$(stty -g)",
      "stty raw -echo",
      "printf '\\033[?1016$p\\033[c'",
      // --foreground: a background process group could not read the terminal
      `timeout --foreground 5 head -c 18 > '${replies}'`,
      'stty "$saved"',
      `exec '${REAL_HERDR}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
    await withServer({ env: { HERDR_FLEET_TOKEN: "", HERDR_FLEET_HERDR_BIN: path } }, async (bridge) => {
      const paneId = await pane();
      const first = await connect(paneId, true, false, bridge);
      try {
        await until(() => first.state.tail.includes("\x1b[?1049h"), "the attach behind the queries paints");
        await until(() => existsSync(replies) && readFileSync(replies, "utf8").length === 18, "the bridge answered");
        expect(readFileSync(replies, "utf8")).toBe("\x1b[?1016;4$y\x1b[?1;2c");
        // a browser joining later gets the replay: the queries are not in it to be answered again
        const second = await connect(paneId, true, false, bridge);
        try {
          for (const client of [first, second]) {
            expect(client.state.tail).not.toContain("1016$p");
            expect(client.state.tail).not.toContain("\x1b[c");
            expect(client.state.errors).toEqual([]);
          }
        } finally { second.ws.close(); }
      } finally { first.ws.close(); }
    });
  }, 30_000);
});
