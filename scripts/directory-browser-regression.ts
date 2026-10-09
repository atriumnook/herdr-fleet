import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";

/**
 * The folder browser in the new session dialog: it opens at the folder typed, goes into a folder,
 * up to its parent and home, shows hidden folders when asked, and puts the folder chosen in the
 * field. A path typed half-way opens home instead.
 */
export async function checkDirectoryBrowser(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-fleet-dir-browser-")));
  mkdirSync(join(root, "alpha", "inner"), { recursive: true });
  mkdirSync(join(root, ".hidden-dir"));
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await context.addInitScript(() => localStorage.setItem("herdr-fleet:settings", JSON.stringify({})));
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole("button", { name: /^New session on / }).click();
    const dialog = page.getByRole("dialog", { name: /^New session/ });
    const field = dialog.getByLabel(/^Directory/);
    const browse = dialog.getByRole("button", { name: "Browse", exact: true });
    const folders = dialog.getByRole("group", { name: "Choose a folder", exact: true });
    const shown = folders.locator(".dir-browser-path");
    const item = (name: string) => folders.getByRole("button", { name, exact: true });
    // a folder inside home shows as ~/…
    const home = homedir();
    const display = (path: string) => (path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path);

    await field.fill(root);
    await browse.click();
    await item("alpha").waitFor();
    assert.equal(await shown.innerText(), display(root));
    assert.equal(await item(".hidden-dir").count(), 0, "hidden folders stay hidden");
    await item("alpha").click();
    await item("inner").waitFor();
    assert.equal(await shown.innerText(), display(join(root, "alpha")));
    await folders.getByRole("button", { name: "Parent folder", exact: true }).click();
    await item("alpha").waitFor();
    assert.equal(await shown.innerText(), display(root));
    await folders.getByLabel("Show hidden").check();
    await item(".hidden-dir").waitFor();
    await item("alpha").click();
    await item("inner").waitFor();
    await folders.getByRole("button", { name: "Use this folder", exact: true }).click();
    await folders.waitFor({ state: "detached" });
    assert.equal(await field.inputValue(), display(join(root, "alpha")));
    console.log("PASS the folder browser goes into a folder and up, shows hidden ones, and fills the field");

    await field.fill("/nonexistent-herdr-fleet/half");
    await browse.click();
    await folders.getByRole("button", { name: "Home folder", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".dir-browser-path")?.textContent === "~");
    assert.equal(await folders.getByRole("button", { name: "Home folder", exact: true }).isDisabled(), true, "at home, Home goes nowhere");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log("PASS a folder that is not there opens the browser at home");
  } finally {
    await context.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-dir-browser-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkDirectoryBrowser(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
