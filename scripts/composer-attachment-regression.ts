import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * Files attached to a composer's message: each uploaded file is mentioned in the message by its
 * path, removing one takes its mention out, and one that failed says why.
 */
export async function checkComposerAttachment(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-composer-attachment-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-composer-attachment" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
    await context.addInitScript((id) => {
      if (!localStorage.getItem("herdr-fleet:settings")) localStorage.setItem("herdr-fleet:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`herdr-fleet:view:${id}`, "chat");
    }, pane);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let refuse = false;
    await page.route("**/api/pane/image", async (route) => {
      const { name } = route.request().postDataJSON() as { name: string };
      if (refuse) { await route.fulfill({ status: 413, json: { error: { code: "too_large", message: "the image is too large" } } }); return; }
      await route.fulfill({ json: { path: `/tmp/uploads/${name}` } });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=", "base64");
    const attachments = page.getByLabel("Attached files", { exact: true });

    await composer.fill("look ");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "first.png", mimeType: "image/png", buffer: png },
      { name: "second.png", mimeType: "image/png", buffer: png },
    ]);
    await page.waitForFunction(() => {
      const value = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']")?.value ?? "";
      return value.includes("@/tmp/uploads/first.png") && value.includes("@/tmp/uploads/second.png");
    });
    assert.equal(await attachments.getByText("Attached", { exact: true }).count(), 2);
    await attachments.getByRole("button", { name: "Remove first.png", exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']")?.value ?? "").includes("first.png"));
    assert.match(await composer.inputValue(), /@\/tmp\/uploads\/second\.png/);
    console.log("PASS each uploaded file is mentioned in the message, and removing one takes its mention out");

    refuse = true;
    await page.locator('input[type="file"]').setInputFiles([{ name: "huge.png", mimeType: "image/png", buffer: png }]);
    await attachments.getByText("Failed", { exact: true }).waitFor();
    await page.locator(".composer-note", { hasText: "the image is too large" }).waitFor();
    assert.doesNotMatch(await composer.inputValue(), /huge\.png/);
    assert.deepEqual(errors, []);
    console.log("PASS a file that failed to upload says why, and is not mentioned");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-composer-attachment-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkComposerAttachment(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
