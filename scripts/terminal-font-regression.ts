import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * A font change keeps xterm's input (the textarea the IME writes in) on the cursor. xterm moves
 * it only when the cursor moves, so after a smaller font it stayed where the old cell size put
 * it, below the grid, and the mount of a grid this view does not size scrolled down to it, onto
 * empty space. The window here has no focus: the grid stays herdr's, and no resize moves the cursor.
 */
export async function checkTerminalFontChange(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-font-"));
  const cwd = join(root, "pane");
  mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-fleet-test-font" });
  const paneId = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".pane-terminal .xterm-rows").waitFor();
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      window.dispatchEvent(new Event("blur"));
    });
    // the prompt on the grid's last row, where a smaller font moves the cursor's cell the most
    await paneSendText(paneId, "seq 1 200");
    await paneSendKeys(paneId, ["Enter"]);
    await page.waitForFunction(() => /\b200\b/.test(document.querySelector(".pane-terminal .xterm-rows")?.textContent ?? ""));

    await page.getByRole("button", { name: "Settings" }).click();
    const smaller = page.getByRole("button", { name: "Decrease terminal font size" });
    for (let step = 0; step < 3; step += 1) await smaller.click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".pane-terminal .xterm-rows")!).fontSize === "10px");
    await page.waitForTimeout(300);

    const placed = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".pane-terminal")!;
      const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
      const input = host.querySelector<HTMLElement>(".xterm-helper-textarea")!;
      const cursorRow = [...host.querySelectorAll<HTMLElement>(".xterm-rows > div")].findIndex((row) => row.querySelector(".xterm-cursor"));
      return {
        cursorRow,
        rowHeight: screen.offsetHeight / host.querySelectorAll(".xterm-rows > div").length,
        inputTop: input.offsetTop,
        scrollHeight: host.scrollHeight,
        // a mount scrolls as far as the larger of itself and the grid
        reach: Math.max(host.clientHeight, host.querySelector<HTMLElement>(".xterm")!.offsetHeight),
      };
    });
    assert.ok(placed.cursorRow >= 0, "the cursor is drawn on a row");
    assert.ok(Math.abs(placed.inputTop - placed.cursorRow * placed.rowHeight) <= 1,
      `after a font change the input sits on the cursor's row (${placed.inputTop}px, the row at ${placed.cursorRow * placed.rowHeight}px)`);
    assert.ok(placed.scrollHeight <= placed.reach + 1, `the mount scrolls no further than the grid (${placed.scrollHeight}px, the grid or the mount ${placed.reach}px)`);
    console.log("PASS a font change keeps the terminal's input on the cursor, and the mount scrolls no further than the grid");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
