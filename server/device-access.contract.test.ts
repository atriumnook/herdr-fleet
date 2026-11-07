// black-box: scripts/contract/launch.ts
import { expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakePushService } from "./push.fake.ts";
import { launchServer } from "../scripts/contract/launch.ts";
import { fileViewUrl } from "../src/lib/api.ts";
import { workspaceCreate, workspaceClose } from "./herdr/client.ts";
import type { ServerMessage } from "../shared/protocol.ts";

const guard = { "x-herdr-machine": "1", "content-type": "application/json" };

async function connect(url: string, cookie: string) {
  // Bun supports handshake headers; lib.dom's browser constructor does not list them.
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: { cookie: string } }) => WebSocket;
  const socket = new RuntimeSocket(url, { headers: { cookie } });
  const messages: ServerMessage[] = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return { socket, messages, closed };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for websocket output");
    await Bun.sleep(20);
  }
}

it("revocation closes an active device's terminal and roster stream without disconnecting another device", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-access-"));
  const server = await launchServer({ env: { HERDR_FLEET_STATE_DIR: root, HERDR_FLEET_TOKEN: "test-device-access" }, test: { tailscaleOwner: null } });
  const base = server.url;
  const admin = { ...guard, authorization: "Bearer test-device-access" };
  const sockets: WebSocket[] = [];
  const abort = new AbortController();
  let workspaceId: string | undefined;
  try {
    const pair = async (label: string) => {
      const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
      const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code, label }) });
      expect(response.status).toBe(204);
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    const cookieA = await pair("A");
    const cookieB = await pair("B");
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string; label: string }[] };
    const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-device-revocation" });
    workspaceId = created.workspace.workspace_id;
    const paneId = created.root_pane.pane_id;
    const a = await connect(`${base.replace("http:", "ws:")}/ws`, cookieA); sockets.push(a.socket);
    const b = await connect(`${base.replace("http:", "ws:")}/ws`, cookieB); sockets.push(b.socket);
    for (const client of [a, b]) {
      client.socket.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24 }));
      await until(() => client.messages.some((message) => message.type === "pty-data"));
    }
    const events = await fetch(`${base}/api/machines/events`, { headers: { cookie: cookieA }, signal: abort.signal });
    const reader = events.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const ended = (async () => { while (!(await reader.read()).done) {} })();
    expect((await fetch(`${base}/api/devices/${devices.find((device) => device.label === "A")!.id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await a.closed).code).toBe(1008);
    await ended;
    expect((await fetch(`${base}/api/session`, { headers: { cookie: cookieA } })).status).toBe(401);
    b.socket.send(JSON.stringify({ type: "role", mode: "observe" }));
    await until(() => b.messages.some((message) => message.type === "role-ack" && message.mode === "observe"));
    expect(b.socket.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`${base}/api/session`, { headers: { cookie: cookieB } })).status).toBe(200);
  } finally {
    abort.abort();
    for (const socket of sockets) socket.close();
    await server.stop();
    if (workspaceId) await workspaceClose(workspaceId);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

it("a corrupt device registry refuses strangers while keeping local recovery and the original file", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-recovery-"));
  const path = join(root, "devices.json");
  writeFileSync(path, "{broken registry");
  const server = await launchServer({ env: { HERDR_FLEET_STATE_DIR: root, HERDR_FLEET_TOKEN: "" }, test: { tailscaleOwner: null } });
  const base = server.url;
  try {
    expect((await fetch(`${base}/api/session`, { headers: { "x-forwarded-for": "192.0.2.1" } })).status).toBe(401);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
    const response = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: guard });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "device_store_unavailable" } });
    expect(readFileSync(path, "utf8")).toBe("{broken registry");
  } finally { await server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("opens a fleet run's results, and no other file of the state folder", async () => {
  // the state folder outside the temp folder, as it is in use (~/.local/state): the temp folder would let anything in it open
  const base = mkdtempSync(join(tmpdir(), "herdr-results-access-"));
  const root = join(base, "state");
  const temp = join(base, "tmp");
  mkdirSync(temp);
  const server = await launchServer({ env: { HERDR_FLEET_STATE_DIR: root, TMPDIR: temp, HERDR_FLEET_TOKEN: "test-results" }, test: { tailscaleOwner: null, machines: false } });
  // after the server started: it drops the results of runs it does not know
  mkdirSync(join(root, "fleet-results", "r1"), { recursive: true });
  writeFileSync(join(root, "fleet-results", "r1", "handoff.md"), "# done");
  writeFileSync(join(root, "devices.json"), "{}");
  symlinkSync(join(root, "devices.json"), join(root, "fleet-results", "r1", "link-out"));
  const base_ = server.url;
  const admin = { ...guard, authorization: "Bearer test-results" };
  const read = (path: string) => fetch(`${base_}/api/fs/file?path=${encodeURIComponent(path)}`, { headers: admin });
  try {
    const handoff = await read(join(root, "fleet-results", "r1", "handoff.md"));
    expect(handoff.status).toBe(200);
    expect(await handoff.text()).toBe("# done");
    expect((await read(join(root, "devices.json"))).status).toBe(403);
    expect((await read(join(root, "fleet-results", "..", "devices.json"))).status).toBe(403);
    expect((await read(join(root, "fleet-results", "r1", "link-out"))).status).toBe(403);
    // an HTML page's files are read through the same checks
    const view = (path: string) => fetch(`${base_}${fileViewUrl(path, null)}`, { headers: admin });
    writeFileSync(join(root, "fleet-results", "r1", "report.html"), "<p>done</p>");
    const page = await view(join(root, "fleet-results", "r1", "report.html"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toStartWith("sandbox allow-same-origin;");
    expect((await view(join(root, "fleet-results", "r1", "handoff.md"))).status).toBe(200);
    expect((await view(join(root, "devices.json"))).status).toBe(403);
    expect((await view(join(root, "fleet-results", "r1", "link-out"))).status).toBe(403);
    expect((await fetch(`${base_}/api/fs/view/-/${encodeURIComponent(join(root, "fleet-results", "..", "devices.json").slice(1))}`, { headers: admin })).status).toBe(403);
    expect((await fetch(`${base_}${fileViewUrl(join(root, "fleet-results", "r1", "report.html"), null)}`, { method: "POST", headers: admin })).status).toBe(400);
  } finally {
    await server.stop();
    rmSync(base, { recursive: true, force: true });
  }
});

it("an empty segment in the path names no route", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-empty-segment-"));
  const server = await launchServer({ env: { HERDR_FLEET_STATE_DIR: root, HERDR_FLEET_TOKEN: "test-segment" }, test: { tailscaleOwner: null, machines: false } });
  const base = server.url;
  try {
    for (const path of ["api//fs/file", "api/machines/pc1//fs/file", "api/machines/pc1/fs//file"]) {
      const response = await fetch(`${base}/${path}?path=${encodeURIComponent(join(root, "devices.json"))}`, { headers: { authorization: "Bearer test-segment" } });
      expect(response.status).toBe(404);
    }
  } finally { await server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("revoking a paired device removes its persistent push subscription", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-push-"));
  const server = await launchServer({ env: { HERDR_FLEET_STATE_DIR: root, HERDR_FLEET_TOKEN: "test-push-owner" }, test: { tailscaleOwner: null, machines: false, acceptLoopbackPush: true } });
  const fake = await startFakePushService();
  const base = server.url;
  const admin = { ...guard, authorization: "Bearer test-push-owner" };
  try {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code }) });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    const registered = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, cookie }, body: JSON.stringify({ subscription: fake.subscription }) });
    expect(registered.status).toBe(204);
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string }[] };
    const id = devices[0]!.id;
    expect(JSON.parse(readFileSync(join(root, "push-subscriptions.json"), "utf8"))[0].device_id).toBe(id);
    expect((await fetch(`${base}/api/devices/${id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(401);
    expect(JSON.parse(readFileSync(join(root, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: admin, body: JSON.stringify({ endpoint: fake.subscription.endpoint }) })).status).toBe(404);
  } finally { fake.stop(); await server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("without the loopback push test option, refuses a push endpoint that is no browser vendor's", async () => {
  const server = await launchServer({ env: { HERDR_FLEET_TOKEN: "test-push-vendor" }, test: { machines: false } });
  // a well-formed subscription whose only fault is its endpoint on 127.0.0.1; nothing listens there
  const device = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const subscription = {
    endpoint: `http://127.0.0.1:9/push/${crypto.randomUUID()}`,
    keys: {
      p256dh: Buffer.from(await crypto.subtle.exportKey("raw", device.publicKey)).toString("base64url"),
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
    },
  };
  try {
    const refused = await fetch(`${server.url}/api/push/subscribe`, {
      method: "POST", headers: { ...guard, authorization: "Bearer test-push-vendor" }, body: JSON.stringify({ subscription }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "invalid_subscription" } });
  } finally { await server.stop(); }
});

it("lists a pane's files without running a command the repository's own config names (core.fsmonitor)", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-pane-files-fsmonitor-"));
  const marker = join(root, "fsmonitor-ran");
  const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", root, ...args]).exitCode).toBe(0);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "README.md"), "# fixture\n");
  writeFileSync(join(root, "src", "api.ts"), "export {};\n");
  git("init", "-q");
  git("add", "README.md", "src/api.ts");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  writeFileSync(join(root, "hook.sh"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  git("config", "core.fsmonitor", join(root, "hook.sh"));
  const server = await launchServer({ env: { HERDR_FLEET_TOKEN: "test-pane-files" }, test: { machines: false } });
  let workspaceId: string | undefined;
  try {
    const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-pane-files-fsmonitor" });
    workspaceId = created.workspace.workspace_id;
    const response = await fetch(`${server.url}/api/pane/files?pane_id=${encodeURIComponent(created.root_pane.pane_id)}&limit=100`, { headers: { authorization: "Bearer test-pane-files" } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { files: string[] }).files).toContain("src/api.ts");
    expect(existsSync(marker)).toBe(false);
  } finally {
    await server.stop();
    if (workspaceId) await workspaceClose(workspaceId);
    rmSync(root, { recursive: true, force: true });
  }
});
