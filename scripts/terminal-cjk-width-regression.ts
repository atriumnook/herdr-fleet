import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * Japanese punctuation keeps its two cells. The page is lang="ja", and Chrome halves full-width
 * punctuation when it repeats (text-spacing-trim), as in the run xterm measures a character by:
 * xterm gave 。 and 、 the half it measured as letter-spacing, the row drew them full width, and
 * each pushed the rest of its row right, so a line as wide as the pane ran past the mount's edge
 * and its end was cut off.
 */
export async function checkTerminalCjkWidths(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-cjk-width-"));
  const cwd = join(root, "pane");
  mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-fleet-test-cjk-width" });
  const paneId = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".pane-terminal .xterm-rows").waitFor();
    // a row as wide as the pane: "あa。、" runs up to its last column, which holds Z
    await paneSendText(paneId, "clear; n=$(( ($(tput cols) - 1) / 7 )); for i in $(seq $n); do printf 'あa。、'; done; printf 'Z\\n'; echo cols=$(tput cols) n=$n");
    await paneSendKeys(paneId, ["Enter"]);
    const handle = await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(".pane-terminal .xterm-rows > div")];
      const answer = rows.map((row) => /^cols=(\d+) n=(\d+)/.exec(row.textContent ?? "")).find(Boolean);
      const line = rows.find((row) => /^(あa。、)+Z/.test(row.textContent ?? ""));
      if (!answer || !line) return null;
      // the text node that holds Z, however the row's spans are split
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let z: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.includes("Z")) z = node as Text;
      if (!z) return null;
      const range = document.createRange();
      const at = z.data.lastIndexOf("Z");
      range.setStart(z, at);
      range.setEnd(z, at + 1);
      const screen = document.querySelector<HTMLElement>(".pane-terminal .xterm-screen")!.getBoundingClientRect();
      return { cols: Number(answer[1]), pairs: Number(answer[2]), right: range.getBoundingClientRect().right - screen.left, width: screen.width };
    }, undefined, { timeout: 15_000 });
    const drawn = (await handle.jsonValue())!;
    const cell = drawn.width / drawn.cols;
    // Z is the cell after the pairs' 7 columns each
    assert.ok(Math.abs(drawn.right - (drawn.pairs * 7 + 1) * cell) <= 1,
      `Japanese punctuation keeps its two cells: Z ends at ${drawn.right}px, its column at ${(drawn.pairs * 7 + 1) * cell}px`);
    assert.ok(drawn.right <= drawn.width + 1, "a row as wide as the pane stays inside the screen");
    console.log(`PASS Japanese punctuation keeps its two cells: a ${drawn.cols}-column row ends at the screen's edge`);
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
