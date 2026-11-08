import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";
import { candidatePorts } from "../scripts/contract/launch.ts";

/**
 * What server/submit.contract.test.ts cannot check through a URL alone (ADR 0122): herdr's answer to
 * whether it can `terminal attach` is held back by a Promise the test settles, so the server runs in
 * this process. The pane runs the same raw-mode recorder as there: every chunk of input it reads.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-fleet-submit-herdr-"));
const workspaces: string[] = [];

const RECORDER = `
const { appendFileSync, writeFileSync } = require("node:fs");
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\\u001b[?2004h", () => writeFileSync(out, ""));
process.stdin.on("data", (chunk) => appendFileSync(out, JSON.stringify({ at: Date.now(), data: chunk.toString("utf8") }) + "\\n"));
`;

afterAll(async () => {
  for (const id of workspaces) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

it("takes its turn before herdr has said what it can do: a message sent meanwhile does not overtake it", async () => {
  writeFileSync(join(root, "record.js"), RECORDER);
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "herdr-fleet-test-submit-unsure", cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const pane = created.root_pane.pane_id;
  const log = join(root, "shell.jsonl");
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${process.execPath}' '${join(root, "record.js")}' '${log}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  const typed = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { data: string }).data).join("");

  let answer!: (attach: boolean) => void;
  const asked = new Promise<boolean>((resolve) => { answer = resolve; });
  const unsure = createServer({ port: candidatePorts().next().value!, stateDir: join(root, "state"), tailscaleOwner: null, terminalAttach: () => asked });
  const ws = new WebSocket(`ws://127.0.0.1:${unsure.port}/ws`);
  const seen: any[] = [];
  ws.addEventListener("message", (event) => seen.push(JSON.parse(String((event as MessageEvent).data))));
  const waitFor = async (predicate: (message: any) => boolean): Promise<any> => {
    for (let waited = 0; waited < 15_000; waited += 25) {
      const found = seen.find(predicate);
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error("frame not received within 15000ms");
  };
  const result = (id: number) => waitFor((message) => message.type === "submit-result" && message.id === id);
  try {
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    await waitFor((message) => message.type === "snapshot");
    ws.send(JSON.stringify({ type: "submit", id: 23, pane_id: pane, text: "one", payload: "one" }));
    ws.send(JSON.stringify({ type: "input", pane_id: pane, text: "\u001b" }));
    ws.send(JSON.stringify({ type: "submit", id: 24, pane_id: pane, text: "two", payload: "two" }));
    await result(23);
    answer(false);
    await result(24);
    for (let i = 0; i < 100 && typed().split("\r").length <= 2; i++) await Bun.sleep(50);
    expect(typed()).toBe("one\r\u001btwo\r");
  } finally {
    answer(false);
    ws.close();
    unsure.stop();
  }
}, 30_000);
