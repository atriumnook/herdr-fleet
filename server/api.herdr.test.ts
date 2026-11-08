import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { candidatePorts } from "../scripts/contract/launch.ts";

/**
 * What server/api.contract.test.ts cannot check through a URL alone (ADR 0122): the fleet's
 * runtime here is a fake whose functions run in this process, so the server runs here too.
 */

/**
 * createServer on the first port in 7400-7499 it can bind. Another test process can take a port
 * between the check and the bind, so a port in use is skipped as the launcher does. A createServer
 * that failed to bind leaves what it started before Bun.serve (the collector) to this test process.
 */
function serveInTestPorts(options: Omit<NonNullable<Parameters<typeof createServer>[0]>, "port">): ReturnType<typeof createServer> {
  for (const port of candidatePorts()) {
    try {
      return createServer({ ...options, port });
    } catch (error) {
      if (!/EADDRINUSE/.test(String(error))) throw error;
    }
  }
  throw new Error("no free port in 7400-7499");
}

describe("fleet change push", () => {
  it("tells event-stream clients once after a burst of fleet run changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-fleet-contract-fleet-"));
    const { UsageTracker } = await import("./fleet/usage.ts");
    let panes = 0;
    const fleetServer = serveInTestPorts({
      hostname: "127.0.0.1", token: "", stateDir: dir,
      fleet: {
        runtime: {
          createLocation: async (options) => ({ paneId: `w9:p${++panes}`, cwd: options.cwd }),
          start: async () => "idle", prompt: async () => "working", get: async () => "working", read: async () => "", screen: async () => "",
          closePane: async () => {}, interrupt: async () => {}, focus: async () => {}, reportMetadata: async () => {},
        },
        agents: () => [{ name: "worker", description: "w", agent: "pi", systemPrompt: "", source: "bundled", filePath: "" }],
        usage: new UsageTracker({ file: null }),
      },
    });
    const abort = new AbortController();
    try {
      const url = `http://127.0.0.1:${fleetServer.port}`;
      const events = await fetch(`${url}/api/machines/events`, { signal: abort.signal });
      const reader = events.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const spawned = await fetch(`${url}/api/fleet/spawn`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-fleet": "1" }, body: JSON.stringify({ role: "worker", task: "t", cwd: dir }) });
      expect(spawned.status).toBe(201);
      const deadline = Date.now() + 3000;
      while (!text.includes('"fleet-changed"') && Date.now() < deadline) text += decoder.decode((await reader.read()).value, { stream: true });
      // a spawn saves its run several times; the burst arrives as one push
      await Bun.sleep(400);
      while (true) {
        const next = await Promise.race([reader.read(), Bun.sleep(50).then(() => null)]);
        if (!next || next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      expect(text.split('"fleet-changed"').length - 1).toBe(1);
    } finally {
      abort.abort();
      fleetServer.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
