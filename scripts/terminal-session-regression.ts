import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, WebSocketRoute } from "playwright-core";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * The terminal lens says what its socket hears of the pane: held by another app until it lets
 * go, input the pane refused (dismissed by hand), a bridge that cannot attach a terminal, and a
 * pane that ended. The server's messages are put on the real socket, beside its own.
 */
export async function checkTerminalSession(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-session-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-session" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await context.addInitScript((id) => {
      localStorage.setItem("herdr-fleet:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`herdr-fleet:view:${id}`, "terminal");
    }, pane);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let route: WebSocketRoute | null = null;
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      route = socket;
      const upstream = socket.connectToServer();
      upstream.onMessage((raw) => socket.send(raw));
    });
    const say = (message: object): void => { assert.ok(route, "the terminal socket is open"); route.send(JSON.stringify(message)); };
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const banner = (text: string) => page.locator(".terminal-banner", { hasText: text });

    say({ type: "error", code: "attach_held", message: "held", pane_id: pane });
    await banner("Another app has this pane open").waitFor();
    say({ type: "attach-resumed", pane_id: pane });
    await banner("Another app has this pane open").waitFor({ state: "detached" });
    // a wait for a pane this terminal left is not this pane's
    say({ type: "error", code: "attach_held", message: "held", pane_id: "w999:p1" });
    await Bun.sleep(300);
    assert.equal(await banner("Another app has this pane open").count(), 0);
    console.log("PASS the terminal says another app holds the pane, until it lets go");

    say({ type: "error", code: "input_failed", message: "The pane did not take the input.", pane_id: pane });
    const refused = banner("The pane did not take the input.");
    await refused.waitFor();
    // the banners let the grid under them take clicks: this one's button takes its own
    await refused.getByRole("button", { name: "Dismiss", exact: true }).click();
    await refused.waitFor({ state: "detached" });
    console.log("PASS input the pane refused is said, and goes when dismissed");

    say({ type: "error", code: "terminal_unsupported", message: "unsupported", pane_id: pane });
    await banner("Live terminal is coming to Windows PCs").waitFor();
    say({ type: "pty-exit", pane_id: pane, code: 0 });
    await banner("terminal ended").waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS the terminal says a bridge that cannot attach, and a pane that ended");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-session-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkTerminalSession(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
