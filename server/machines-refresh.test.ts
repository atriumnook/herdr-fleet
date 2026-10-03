import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("fixture did not reach the expected state");
}

function snapshot(agent_status = "working"): SessionSnapshot {
  return {
    protocol: 22, version: "fixture", workspaces: [], tabs: [], layouts: [], agents: [],
    panes: [{ pane_id: "fixture:p1", agent: "codex", agent_status, focused: false, revision: 1, tab_id: "fixture:t1", terminal_id: "fixture:terminal", workspace_id: "fixture" }],
  };
}

/** Actual RPC/HTTP responses wait at the server, after capturing their older state. */
function responses() {
  let current = snapshot();
  let hold = false;
  let calls = 0;
  const pending: (() => void)[] = [];
  return {
    read(): Promise<SessionSnapshot> {
      calls++;
      const captured = structuredClone(current);
      return new Promise((resolve) => { if (hold) pending.push(() => resolve(captured)); else resolve(captured); });
    },
    hold: () => { hold = true; },
    set: (next: SessionSnapshot) => { current = next; },
    calls: () => calls,
    waiting: () => pending.length,
    answer: () => pending.shift()!(),
    finish: () => { hold = false; while (pending.length) pending.shift()!(); },
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-machine-refresh-"));
  const path = join(root, "herdr.sock");
  const local = responses();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!);
      if (request.method !== "session.snapshot") throw new Error(`unexpected fixture RPC: ${request.method}`);
      void local.read().then((captured) => socket.end(JSON.stringify({ id: request.id, result: { snapshot: captured } }) + "\n"));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const previousSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  const manager = new MachineManager(new CompletionTracker(null));
  cleanups.push(() => {
    manager.stop(); local.finish();
    for (const socket of sockets) socket.destroy();
    server.close();
    if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previousSocket;
    rmSync(root, { recursive: true, force: true });
  });
  await until(() => manager.list()[0]?.state === "connected");
  const drive = manager as unknown as { localBusy: boolean };
  const rosters: string[] = [];
  manager.subscribe((event) => {
    if (event.type === "machines") for (const machine of event.machines) {
      const status = machine.snapshot?.panes[0]?.agent_status;
      if (status) rosters.push(`${machine.id}:${status}`);
    }
  });
  return { manager, drive, local, rosters };
}

describe("machine snapshot refresh races", () => {
  it("keeps a newer local status and retries the invalidated snapshot", async () => {
    const { manager, drive, local, rosters } = await fixture();
    local.hold();
    const loading = manager.refreshLocal();
    await until(() => local.waiting() === 1);
    local.set(snapshot("blocked"));
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "working" });
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    rosters.length = 0;
    local.answer();
    await until(() => !drive.localBusy || local.waiting() === 1);
    expect(manager.list()[0]?.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(local.calls()).toBe(3);
    local.answer();
    await loading;
    expect(rosters).not.toContain("local:working");
    expect(rosters).toContain("local:blocked");
  });

  it("queues a local structure refresh requested while another is pending", async () => {
    const { manager, drive, local } = await fixture();
    local.hold();
    const loading = manager.refreshLocal();
    await until(() => local.waiting() === 1);
    local.set({ ...snapshot("blocked"), panes: [] });
    manager.localMessage({ type: "session-changed" });
    local.answer();
    await until(() => !drive.localBusy || local.waiting() === 1);
    expect(local.calls()).toBe(3);
    local.answer();
    await loading;
    expect(manager.list()[0]?.snapshot?.panes).toEqual([]);
  });

  it("stops a local refresh without publishing or retrying its pending response", async () => {
    const { manager, local, rosters } = await fixture();
    local.hold();
    const loading = manager.refreshLocal();
    await until(() => local.waiting() === 1);
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    manager.stop();
    rosters.length = 0;
    local.answer();
    await loading;
    expect(local.calls()).toBe(2);
    expect(manager.list()[0]?.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(rosters).toEqual([]);
  });
});
