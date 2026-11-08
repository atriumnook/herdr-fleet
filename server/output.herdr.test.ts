import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";
import { candidatePorts } from "../scripts/contract/launch.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/**
 * What server/output.contract.test.ts cannot check through a URL alone (ADR 0122): these change
 * the running server's PATH so that it cannot spawn the Node PTY sidecar, so the server runs in
 * this process. The Rust core has no Node sidecar, and runs none of these.
 */

/**
 * createServer on the first port in 7400-7499 it can bind. Another test process can take a port
 * between the check and the bind, so a port in use is skipped as the launcher does. Bun names
 * the port in use in the error's code; its message only asks "Is port N in use?".
 */
function serveInTestPorts(options: Omit<NonNullable<Parameters<typeof createServer>[0]>, "port">): ReturnType<typeof createServer> {
  for (const port of candidatePorts()) {
    try {
      return createServer({ ...options, port });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("no free port in 7400-7499");
}

const root = mkdtempSync(join(tmpdir(), "herdr-output-herdr-"));
let server: ReturnType<typeof createServer>;
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
beforeAll(() => {
  server = serveInTestPorts({ hostname: "127.0.0.1", token: "", stateDir: root });
});
afterAll(async () => {
  for (const socket of sockets) socket.close();
  server?.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function pane(): Promise<string> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "herdr-fleet-test-output", cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  return created.root_pane.pane_id;
}

async function connect(paneId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  sockets.push(ws);
  const state = { frames: 0, code: 0, exits: 0, errors: [] as string[] };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") state.errors.push(frame.code);
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type !== "pty-data" || frame.pane_id !== paneId) return;
    state.frames++;
    if (frame.flow && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pty-ack", pane_id: paneId, ...frame.flow } satisfies ClientMessage));
  });
  ws.addEventListener("close", (event) => { state.code = event.code; });
  await until(() => ws.readyState === WebSocket.OPEN, "socket open");
  ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" } satisfies ClientMessage));
  await until(() => state.frames > 0, "initial terminal paint");
  return { ws, state };
}

/** Bun.spawn throws synchronously for the pty sidecar while `node` is not on PATH (herdr itself stays found). */
function breakPath(): () => void {
  const previous = process.env["PATH"];
  const previousHerdr = process.env["HERDR_FLEET_HERDR_BIN"];
  process.env["HERDR_FLEET_HERDR_BIN"] = Bun.which(previousHerdr || "herdr", { PATH: previous ?? "" }) ?? previousHerdr ?? "herdr";
  process.env["PATH"] = "/nonexistent";
  return () => {
    process.env["PATH"] = previous;
    if (previousHerdr === undefined) delete process.env["HERDR_FLEET_HERDR_BIN"];
    else process.env["HERDR_FLEET_HERDR_BIN"] = previousHerdr;
  };
}

describe("a terminal attach that cannot spawn (#154)", () => {
  it("reports the failure and leaves the pane attachable, never a record without a pty", async () => {
    const paneId = await pane();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const errors: string[] = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type === "error") errors.push(frame.code);
    });
    await until(() => ws.readyState === WebSocket.OPEN, "socket open");
    const restore = breakPath();
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" } satisfies ClientMessage));
      await until(() => errors.includes("command_failed"), "the failed spawn is reported");
    } finally { restore(); }
    // the next attach spawns its own pty instead of joining a dead record
    const second = await connect(paneId);
    second.ws.close();
    await until(() => second.state.code !== 0, "second client closed");
    // closing it tore the attachment down cleanly: the server still attaches the pane
    const third = await connect(paneId);
    try {
      expect(third.state.errors).toEqual([]);
      expect(third.state.exits).toBe(0);
    } finally { third.ws.close(); ws.close(); }
  }, 30_000);
});

describe("an attach herdr refuses over a read in progress", () => {
  /**
   * A herdr that refuses the first `refusals` attaches as herdr 0.9 refuses one racing a
   * pane read of the same terminal, then attaches for real.
   */
  function refusingHerdr(refusals: number): { path: string; attempts: () => number } {
    const real = process.env["HERDR_FLEET_HERDR_BIN"] || Bun.which("herdr") || "herdr";
    const dir = mkdtempSync(join(root, "refusing-herdr-"));
    const count = join(dir, "count");
    const path = join(dir, "herdr");
    writeFileSync(path, [
      "#!/bin/sh",
      `n=$(cat '${count}' 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > '${count}'`,
      `if [ "$n" -lt ${refusals} ]; then printf 'herdr: server shut down: terminal attach failed: terminal term_0 has a read in progress; retry\\r\\n'; exit 1; fi`,
      `exec '${real}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
    return { path, attempts: () => existsSync(count) ? Number(readFileSync(count, "utf8").trim() || 0) : 0 };
  }

  async function withHerdr<T>(path: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env["HERDR_FLEET_HERDR_BIN"];
    process.env["HERDR_FLEET_HERDR_BIN"] = path;
    try { return await run(); } finally {
      if (previous === undefined) delete process.env["HERDR_FLEET_HERDR_BIN"];
      else process.env["HERDR_FLEET_HERDR_BIN"] = previous;
    }
  }

  it("ends the terminal, not the server, when a retried attach cannot spawn", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(1);
    await withHerdr(herdr.path, async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      sockets.push(ws);
      const errors: string[] = [];
      let exits = 0;
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        if (frame.type === "error") errors.push(frame.code);
        if (frame.type === "pty-exit" && frame.pane_id === paneId) exits++;
      });
      await until(() => ws.readyState === WebSocket.OPEN, "socket open");
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 } satisfies ClientMessage));
      // the refusal is running: the retry that follows its exit spawns without node
      await until(() => herdr.attempts() === 1, "the refused attach started");
      const restore = breakPath();
      try {
        await until(() => exits === 1, "pty-exit for the retry that failed to spawn");
      } finally { restore(); }
      expect(errors).toEqual(["command_failed"]);
      expect(herdr.attempts()).toBe(1);
      ws.close();
      // the server survived and the pane attaches again for real
      const client = await connect(paneId);
      try {
        expect(client.state.errors).toEqual([]);
        expect(herdr.attempts()).toBe(2);
      } finally { client.ws.close(); }
    });
  }, 30_000);
});
