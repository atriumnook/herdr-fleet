import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationImage, ConversationUnavailable, paneConversation, toolOutput } from "./conversation.ts";

/**
 * paneConversation, conversationImage and toolOutput for an OpenCode 2 pane, through a herdr that
 * answers from memory and an `opencode2` that answers from files: no herdr, no OpenCode, no model.
 * Nothing here is a real conversation.
 */
const SID = "ses_wiringtest0001";
const root = mkdtempSync(join(tmpdir(), "opencode-wiring-"));
const socket = join(root, "herdr.sock");
const saved = { path: process.env["PATH"], socket: process.env["HERDR_SOCKET"], state: process.env["HERDR_FLEET_STATE_DIR"] };
let panes: Record<string, unknown>[] = [];
let session: unknown = { kind: "id", agent: "opencode", source: "herdr:opencode", value: SID };
let listener: { stop: () => void };

const whole = "w".repeat(5000);
const messages = [
  { id: "msg_u", type: "user", time: { created: 1 }, text: "<user text>", files: [{ data: Buffer.from("<png>").toString("base64"), mime: "image/png", source: { type: "inline" } }] },
  { id: "msg_a", type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 2, completed: 3 }, finish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: "tool", id: "c", name: "bash", time: { created: 2 }, state: { status: "completed", input: { command: "<c>" }, content: [{ type: "text", text: whole }], metadata: { exit: 0 } } }, { type: "text", text: "<answer>" }] },
];

beforeAll(() => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "state"), "running");
  writeFileSync(join(root, "session.json"), JSON.stringify({ data: { id: SID, time: { created: 1, updated: 3 }, tokens: { input: 1, output: 1 }, cost: 0 } }));
  writeFileSync(join(root, "list.json"), JSON.stringify({ data: [...messages].reverse() }));
  for (const message of messages) writeFileSync(join(root, `${message.id}.json`), JSON.stringify({ data: message }));
  writeFileSync(join(root, "model.json"), JSON.stringify({ data: [{ id: "m", modelID: "m", providerID: "p", limit: { context: 1000 } }] }));
  const script = `#!/bin/sh
if [ "$1" = service ]; then if [ "$(cat ${root}/state)" = running ]; then echo http://127.0.0.1:1; else echo stopped; fi; exit 0; fi
case "$3" in
  /api/model) cat ${root}/model.json;;
  /api/session/*/message/*) cat ${root}/\${3##*/}.json;;
  /api/session/*/message?*) cat ${root}/list.json;;
  /api/session/*) cat ${root}/session.json;;
esac
`;
  writeFileSync(join(bin, "opencode2"), script);
  chmodSync(join(bin, "opencode2"), 0o755);
  process.env["PATH"] = `${bin}:${saved.path ?? ""}`;
  process.env["HERDR_FLEET_STATE_DIR"] = root;
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen({
    unix: socket,
    socket: {
      data(client, chunk) {
        for (const line of Buffer.from(chunk).toString().split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as { id: string; method: string };
          const result = request.method === "session.snapshot" ? { snapshot: { panes } }
            : request.method === "agent.get" ? { agent: { agent_session: session } } : {};
          client.write(`${JSON.stringify({ id: request.id, result })}\n`);
        }
      },
    },
  });
});

afterAll(() => {
  listener?.stop();
  for (const [name, value] of [["PATH", saved.path], ["HERDR_SOCKET", saved.socket], ["HERDR_FLEET_STATE_DIR", saved.state]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const pane = (extra: Record<string, unknown> = {}) => ({ pane_id: "p1", cwd: "/work", agent: "opencode", agent_status: "idle", ...extra });

describe("an OpenCode 2 pane", () => {
  test("its conversation is read through the CLI, by the session herdr names", async () => {
    panes = [pane()];
    const page = await paneConversation("p1");
    expect(page.source).toBe("opencode-session");
    expect(page.history_id).toBe(SID);
    expect(page.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(page.turns[0]!.parts[1]).toEqual({ kind: "image", media_type: "image/png", ref: "msg_u:0" });
    expect(page.turns[1]!.parts.at(-1)).toMatchObject({ kind: "text", text: "<answer>", phase: "final_answer" });
    expect(page.metadata).toEqual({ model: "p/m", reasoning_effort: null, context: { used: 1, window: 1000 } });
  });

  test("a cut output and a pasted image are fetched through the pane", async () => {
    panes = [pane()];
    const page = await paneConversation("p1");
    const tool = page.turns[1]!.parts.find((part) => part.kind === "tool") as { output_ref: string; output_size: number };
    expect(tool.output_size).toBe(whole.length);
    expect(await toolOutput("p1", tool.output_ref)).toBe(whole);
    expect(await toolOutput("p1", "msg_a:9")).toBeNull();
    const image = await conversationImage("p1", "msg_u:0");
    expect(image!.mediaType).toBe("image/png");
    expect(Buffer.from(image!.bytes).toString()).toBe("<png>");
    expect(await conversationImage("p1", "msg_u:1")).toBeNull();
  });

  test("a pane herdr reports no session for is read from its scrollback", async () => {
    panes = [pane()];
    session = null;
    await expect(paneConversation("p1")).rejects.toBeInstanceOf(ConversationUnavailable);
    expect(await toolOutput("p1", "msg_a:0")).toBeNull();
    session = { kind: "id", agent: "opencode", source: "herdr:opencode", value: "ses_../x" };
    await expect(paneConversation("p1")).rejects.toBeInstanceOf(ConversationUnavailable);
    session = { kind: "id", agent: "opencode", source: "herdr:opencode", value: SID };
  });

  test("the label is read from the pane's agent session when the pane has none of its own", async () => {
    panes = [pane({ agent: undefined, agent_session: { agent: "opencode", kind: "id", source: "x", value: SID } })];
    expect((await paneConversation("p1")).source).toBe("opencode-session");
  });

  test("with no service running it is read from its scrollback, and the output and image are none", async () => {
    panes = [pane()];
    writeFileSync(join(root, "state"), "stopped");
    // the answer about the service is kept for a moment
    await Bun.sleep(2_100);
    await expect(paneConversation("p1")).rejects.toBeInstanceOf(ConversationUnavailable);
    expect(await toolOutput("p1", "msg_a:0")).toBeNull();
    expect(await conversationImage("p1", "msg_u:0")).toBeNull();
  });
});
