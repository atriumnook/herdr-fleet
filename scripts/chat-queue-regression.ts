import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * Messages held while the agent works: a Send now the pane refuses keeps the message and says
 * why, one goes out at a time, and another tab's edit shows here.
 */
export async function checkChatQueue(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-queue-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-chat-queue" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const report = (state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
  try {
    await report("working");
    await context.addInitScript((id) => {
      if (!localStorage.getItem("herdr-fleet:settings")) localStorage.setItem("herdr-fleet:settings", JSON.stringify({}));
      localStorage.setItem(`herdr-fleet:view:${id}`, "chat");
    }, pane);
    // the pane's answers to Send now: refused, held until released, or passed to the server
    let mode: "refuse" | "hold" | "pass" = "refuse";
    let release: (() => void) | null = null;
    const submits: string[] = [];
    const open = async (): Promise<Page> => {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === "submit" && message.pane_id === pane) {
            submits.push(message.text);
            if (mode === "refuse") { socket.send(JSON.stringify({ type: "submit-result", id: message.id, pane_id: pane, ok: false, code: "input_failed", message: "the pane refused it" })); return; }
            if (mode === "hold") { release = () => socket.send(JSON.stringify({ type: "submit-result", id: message.id, pane_id: pane, ok: true })); return; }
          }
          upstream.send(raw);
        });
        upstream.onMessage((raw) => socket.send(raw));
      });
      await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
      await page.locator(".conn-live").waitFor();
      return page;
    };
    const page = await open();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await page.locator('.composer-status[data-status="working"]').waitFor();
    for (const text of ["# first held", "# second held"]) {
      await composer.fill(text);
      await page.getByRole("button", { name: "Queue message", exact: true }).click();
    }
    const items = page.locator(".composer-queue-text");
    await items.nth(1).waitFor();
    await report("idle");
    await page.locator('.composer-status:not([data-status="working"])').waitFor();

    const sendNow = page.getByRole("button", { name: "Send now", exact: true });
    await sendNow.first().click();
    await page.locator(".composer-queue-error", { hasText: "the pane refused it" }).waitFor();
    assert.equal(await items.count(), 2, "a refused message stays held");
    assert.deepEqual(submits, ["# first held"]);
    console.log("PASS a Send now the pane refuses keeps the message and says why");

    mode = "hold";
    await sendNow.first().click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>(".composer-queue-send")].every((button) => button.disabled));
    await sendNow.nth(1).click({ force: true });
    await Bun.sleep(300);
    assert.equal(submits.length, 2, "one held message goes out at a time");
    (release as (() => void) | null)?.();
    await page.waitForFunction(() => document.querySelectorAll(".composer-queue-text").length === 1);
    assert.equal(await items.first().inputValue(), "# second held");
    console.log("PASS one held message goes out at a time, and only it leaves the queue");

    // another tab's edit shows here
    mode = "pass";
    const other = await open();
    await other.locator(".composer-queue-text").first().fill("# edited elsewhere");
    await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>(".composer-queue-text")?.value ?? "") === "# edited elsewhere");
    await other.close();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await items.first().waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    console.log("PASS another tab's edit to a held message shows here");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-queue-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkChatQueue(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
