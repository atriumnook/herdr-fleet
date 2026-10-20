import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiError, ConversationTurn, ExplainResponse } from "../shared/protocol.ts";
import { createServer } from "./index.ts";

/**
 * POST /api/pane/explain through the whole server, with a fake claude and a conversation given in
 * place of the pane's: no herdr, no model.
 */
const root = mkdtempSync(join(tmpdir(), "explain-route-"));
const gate = join(root, "go");
const turns: ConversationTurn[] = [{ role: "user", ts: null, parts: [{ kind: "text", text: "pick a store" }] }];
let limited: string | undefined;
let server: { port: number; stop: () => void };

beforeAll(() => {
  // a fake claude that answers once the test lets it (the gate file), or after a while on its own
  const fake = join(root, "claude");
  writeFileSync(fake, `#!/bin/sh\ncat > /dev/null\nwhile [ ! -e ${JSON.stringify(gate)} ]; do sleep 0.1; done\necho '{"result":"### 推奨\\n→ 1. Redis","usage":{"input_tokens":10,"output_tokens":5}}'\n`);
  chmodSync(fake, 0o755);
  server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir: root, tailscaleOwner: null,
    explain: { command: fake, conversation: async () => turns, unavailable: async () => limited, env: { PATH: process.env["PATH"] } },
  });
});

afterAll(() => {
  server?.stop();
  rmSync(root, { recursive: true, force: true });
});

const ask = (question: string) => fetch(`http://127.0.0.1:${server.port}/api/pane/explain`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-herdr-machine": "1" },
  body: JSON.stringify({ pane_id: "w1:p1", kind: "plain", question, options: [{ label: "Redis", description: null }] }),
});
const open = (): void => writeFileSync(gate, "");
const shut = (): void => rmSync(gate, { force: true });

describe("POST /api/pane/explain", () => {
  it("says Claude was not asked while its account is at its limit", async () => {
    limited = "claude has used 95% of its 5h limit";
    try {
      const response = await ask("Which store?");
      expect(response.status).toBe(409);
      expect((await response.json()) as ApiError).toEqual({ error: { code: "usage_limited", message: "claude has used 95% of its 5h limit" } });
    } finally {
      limited = undefined;
    }
  });

  it("waits for a call longer than Bun's 10 s idle limit, and answers it", async () => {
    shut();
    const asked = ask("Which store should a slow call pick?");
    setTimeout(open, 15_000);
    const response = await asked;
    expect(response.status).toBe(200);
    expect(((await response.json()) as ExplainResponse).text).toBe("### 推奨\n→ 1. Redis");
  }, 30_000);

  it("refuses a call when one runs and two wait already", async () => {
    shut();
    const running = ask("first?");
    await Bun.sleep(300);
    const waiting = [ask("second?"), ask("third?")];
    await Bun.sleep(300);
    const refused = await ask("fourth?");
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as ApiError).error.code).toBe("explain_busy");
    open();
    for (const response of await Promise.all([running, ...waiting])) expect(response.status).toBe(200);
    expect(existsSync(join(root, "explain", "work"))).toBe(true);
  }, 30_000);
});
