import { expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtySession } from "./pty/session.ts";
import { createServer } from "./index.ts";
import { paneRead, paneSendText, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { candidatePorts } from "../scripts/contract/launch.ts";

/**
 * What server/secret.contract.test.ts cannot check through a URL alone (ADR 0122): a pane's PTY that
 * refuses a write, as a dead sidecar does, is made by a spy on the server's PtySession, so the
 * server runs in this process.
 */
it("secret frames validate prompts and authority, never queue, and type one no-echo line: a dead sidecar does not acknowledge bytes it could not accept", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-secret-"));
  const resultFile = join(root, "result.json");
  const script = join(root, "ask.cjs");
  // a no-echo stand-in, as in server/secret.contract.test.ts: it records only a digest and a byte count
  writeFileSync(script, `
const { writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
process.stdin.setRawMode(true); process.stdin.resume();
let value = "";
process.stdout.write("\\x1b[2J\\x1b[HPassword:");
process.stdin.on("data", chunk => {
  value += chunk.toString();
  if (!value.includes("\\r")) return;
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ hash: createHash("sha256").update(value).digest("hex"), length: value.length }));
  value = ""; process.stdout.write("\\r\\nAccepted\\r\\nReady>");
});
`);
  const server = createServer({ port: candidatePorts().next().value!, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null });
  let workspace: string | undefined;
  let socket: WebSocket | undefined;
  const seen: any[] = [];
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) { if (Date.now() > deadline) throw new Error("Secret contract deadline"); await Bun.sleep(25); }
  };
  try {
    const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-secret-dead-sidecar" });
    workspace = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id;
    await paneSendText(pane, `exec '${Bun.which("node")}' '${script}'\n`);
    await until(async () => (await paneRead({ paneId: pane, source: "visible", format: "text" })).text.trim() === "Password:");
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data))));
    await until(() => seen.some((frame) => frame.type === "snapshot"));
    socket.send(JSON.stringify({ type: "attach", pane_id: pane, cols: 80, rows: 24 }));
    await until(() => seen.some((frame) => frame.type === "pty-data"));
    // A dead sidecar must not acknowledge bytes that it could not accept.
    const rejectedWrite = spyOn(PtySession.prototype, "write").mockReturnValue(false);
    try {
      socket.send(JSON.stringify({ type: "secret", id: 9, pane_id: pane, prompt: "Password:", secret: "fixture-value" }));
      await until(() => seen.some((frame) => frame.type === "secret-result" && frame.id === 9));
      expect(seen.find((frame) => frame.type === "secret-result" && frame.id === 9)).toMatchObject({ ok: false, code: "input_not_ready" });
      expect(existsSync(resultFile)).toBe(false);
    } finally { rejectedWrite.mockRestore(); }
  } finally {
    socket?.close(); server.stop();
    if (workspace) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
