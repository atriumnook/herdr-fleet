import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const PROMPT: InteractivePrompt = {
  id: "approve-1", agent: "claude", kind: "approval", title: "Allow the edit?", question: "Edit src/app.ts?", body: null,
  options: [{ label: "Yes", description: null }, { label: "No", description: null }], multi_select: false, custom_option_index: null,
};

/**
 * The chat lens reads the waiting prompt while it is open, the page is on screen and the pane
 * is live: a hidden page reads nothing and reads at once when it is back, and the terminal lens
 * shows no card (the chat asks again when it opens).
 */
export async function checkChatPrompt(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-prompt-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-chat-prompt" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "blocked" });
    await context.addInitScript((id) => {
      if (!localStorage.getItem("herdr-fleet:settings")) localStorage.setItem("herdr-fleet:settings", JSON.stringify({}));
      localStorage.setItem(`herdr-fleet:view:${id}`, "chat");
    }, pane);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let reads = 0;
    await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`, async (route) => {
      reads += 1;
      await route.fulfill({ json: { prompt: PROMPT, suggestion: null } });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const card = page.locator(".prompt-card");
    await card.getByText("Edit src/app.ts?").waitFor();
    const setVisible = (visible: boolean) => page.evaluate((shown) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: shown ? "visible" : "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    }, visible);

    await setVisible(false);
    await Bun.sleep(300);
    const hiddenAt = reads;
    await Bun.sleep(4_500);
    assert.equal(reads, hiddenAt, "a hidden page reads no prompt");
    await setVisible(true);
    for (let i = 0; i < 20 && reads === hiddenAt; i++) await Bun.sleep(50);
    assert.ok(reads > hiddenAt, "back on screen, the prompt is read at once");
    await card.waitFor();
    console.log("PASS the chat reads no prompt while the page is hidden, and reads at once when it is back");

    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await card.waitFor({ state: "detached" });
    const terminalAt = reads;
    await Bun.sleep(4_500);
    assert.equal(reads, terminalAt, "the terminal lens reads no prompt");
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await card.getByText("Edit src/app.ts?").waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS the terminal lens shows no prompt card, and the chat asks again when it opens");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-prompt-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkChatPrompt(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
