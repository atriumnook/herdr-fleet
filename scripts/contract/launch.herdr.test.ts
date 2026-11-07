import { expect, it } from "bun:test";
import { launchServer, type TestOptions } from "./launch.ts";

/**
 * The localPty default of ADR 0122, seen from outside: /api/health tells a server that cannot run a
 * pane's terminal on its own PTY the way a Windows herdr would (terminal_attach false), so the
 * answer shows which value localPty took. Needs the test herdr, which /api/health asks.
 */
async function health(test: TestOptions): Promise<{ terminal_attach?: boolean }> {
  const server = await launchServer({ env: { HERDR_FLEET_TOKEN: "test-local-pty" }, test: { machines: false, ...test } }, { target: { kind: "ts" } });
  try {
    const response = await fetch(`${server.url}/api/health`, { headers: { authorization: "Bearer test-local-pty" } });
    expect(response.status).toBe(200);
    return ((await response.json()) as { herdr: { terminal_attach?: boolean } }).herdr;
  } finally {
    await server.stop();
  }
}

it("takes terminalAttach's value for localPty when the test sets only terminalAttach", async () => {
  const ownPty = await health({ localPty: true });
  // the test herdr runs on Linux or macOS, which can attach: otherwise the checks below could not tell the values apart
  expect(ownPty.terminal_attach).not.toBe(false);
  expect((await health({ localPty: false })).terminal_attach).toBe(false);
  // unset, localPty follows terminalAttach: false turns the PTY off, true leaves herdr's own answer
  expect((await health({ terminalAttach: false })).terminal_attach).toBe(false);
  expect((await health({ terminalAttach: true })).terminal_attach).toBe(ownPty.terminal_attach);
  // a localPty the test sets wins
  expect((await health({ terminalAttach: true, localPty: false })).terminal_attach).toBe(false);
}, 30_000);
