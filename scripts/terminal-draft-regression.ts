import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, WebSocketRoute } from "playwright-core";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * Typing into the terminal while its socket is down: nothing is queued to fire later. The
 * printable text is held, survives a reload, and once the terminal is back it is sent only
 * when the person says so, or discarded.
 */
export async function checkTerminalDraft(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-draft-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-draft" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await context.addInitScript((id) => {
      if (!localStorage.getItem("herdr-fleet:settings")) localStorage.setItem("herdr-fleet:settings", JSON.stringify({}));
      localStorage.setItem(`herdr-fleet:view:${id}`, "terminal");
    }, pane);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // the terminal's socket, refused while `down`: the page then holds what is typed
    let down = false;
    let route: WebSocketRoute | null = null;
    const sent: string[] = [];
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      if (down) { void socket.close(); return; }
      route = socket;
      const upstream = socket.connectToServer();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        // what was typed: the pointer moving over the grid sends mouse reports besides
        if (message.type === "input" && message.pane_id === pane && !String(message.text).startsWith("\x1b[<")) sent.push(message.text);
        upstream.send(raw);
      });
      upstream.onMessage((raw) => socket.send(raw));
    });
    const live = page.locator(".conn-live");
    const goDown = async (): Promise<void> => {
      down = true;
      await route?.close();
      await page.locator(".conn-reconnecting").waitFor();
    };
    const comeBack = async (): Promise<void> => {
      down = false;
      // the socket retries with a growing pause; Send waits for the pane to take input again
      await live.waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => ![...document.querySelectorAll(".terminal-banner")].some((banner) => banner.textContent?.includes("Waiting for terminal input")));
    };
    const held = page.locator(".terminal-banner-draft");
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await live.waitFor();
    await page.locator(".xterm-screen").click();

    await goDown();
    await page.keyboard.type("echo held");
    await page.keyboard.press("Enter");
    await page.getByText("input held: “echo held”").waitFor();
    assert.deepEqual(sent, [], "typing while down sends nothing");
    // a reload keeps it
    await page.reload();
    await page.getByText("input held: “echo held”").waitFor();
    console.log("PASS input typed while the terminal is down is held, and survives a reload");

    await comeBack();
    await held.waitFor();
    assert.equal(await held.locator(".draft-text").innerText(), "echo held");
    assert.match(await held.innerText(), /1 special key dropped/);
    assert.deepEqual(sent, [], "nothing is sent by itself once the terminal is back");
    // typed beside the held start, a line and its Enter would run without it: they join the draft
    await page.locator(".xterm-screen").click();
    await page.keyboard.type(" again");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".terminal-banner-draft .draft-text")?.textContent === "echo held again");
    assert.deepEqual(sent, [], "typing beside held input sends nothing");
    // an interrupt still reaches the program
    await page.keyboard.press("Control+c");
    for (let wait = 0; wait < 50 && !(sent as string[]).includes("\x03"); wait++) await page.waitForTimeout(20);
    assert.deepEqual(sent, ["\x03"], "Ctrl+C reaches the program beside held input");
    console.log("PASS typing beside held input joins it, and an interrupt still goes through");
    await held.getByRole("button", { name: "Send", exact: true }).click();
    await held.waitFor({ state: "detached" });
    assert.deepEqual(sent, ["\x03", "echo held again"]);
    console.log("PASS the held input is sent when the person says so, once");

    await page.locator(".xterm-screen").click();
    await goDown();
    await page.keyboard.type("rm -rf nothing");
    await comeBack();
    await held.waitFor();
    await held.getByRole("button", { name: "Discard", exact: true }).click();
    await held.waitFor({ state: "detached" });
    await page.reload();
    await live.waitFor();
    assert.equal(await held.count(), 0, "a discarded draft stays gone after a reload");
    assert.deepEqual(sent, ["\x03", "echo held again"]);
    assert.deepEqual(errors, []);
    console.log("PASS the held input can be discarded instead");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-draft-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkTerminalDraft(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
