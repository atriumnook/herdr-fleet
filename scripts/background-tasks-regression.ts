import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { OmoTask } from "../shared/protocol.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const task = (id: string, status: OmoTask["status"], title: string): OmoTask => ({
  id, title, status, category: null, model: null, started_at: new Date(Date.now() - 65_000).toISOString(), ended_at: status === "running" ? null : new Date().toISOString(),
  turns: null, tool_calls: null, tokens: null,
} as OmoTask);

/**
 * The status line's background tasks on an OmO pane: the list opens on what runs now, with
 * what ended folded into one line; it reads the pane's tasks again while open, and stops once
 * closed. Escape and a press outside close it. A read that fails keeps the list as it last read.
 */
export async function checkBackgroundTasks(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-bg-tasks-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-bg-tasks" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "omo", state: "idle" });
    await context.addInitScript((id) => {
      localStorage.setItem("herdr-fleet:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`herdr-fleet:view:${id}`, "chat");
    }, pane);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let reads = 0;
    let failing = false;
    await page.route("**/api/pane/omo-tasks?*", async (route) => {
      reads += 1;
      if (failing) { await route.fulfill({ status: 500, json: { error: { code: "internal", message: "down" } } }); return; }
      await route.fulfill({ json: {
        tasks: [task("t1", "running", "Index the repository"), task("t2", "completed", "Write the summary"), task("t3", "failed", "Run the linter")],
        runs: [], server_time: new Date().toISOString(),
      } });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const toggle = page.locator(".bg-tasks-toggle");
    await toggle.waitFor();
    const list = page.getByRole("dialog", { name: "Background tasks", exact: true });

    await toggle.click();
    await list.getByText("Index the repository").waitFor();
    assert.equal(await list.getByText("Write the summary").isVisible(), false, "what ended stays folded");
    const ended = list.getByRole("button", { name: /2 recently ended/ });
    assert.match(await ended.innerText(), /1 failed/);
    await ended.click();
    await list.getByText("Write the summary").waitFor();
    const first = reads;
    for (let i = 0; i < 80 && reads === first; i++) await Bun.sleep(100);
    assert.ok(reads > first, "the open list reads the tasks again");
    console.log("PASS background tasks open on what runs, fold what ended, and read again while open");

    await page.keyboard.press("Escape");
    await list.waitFor({ state: "detached" });
    const closedAt = reads;
    await Bun.sleep(3_500);
    assert.equal(reads, closedAt, "a closed list reads nothing");
    // opened again, it starts on what runs now
    await toggle.click();
    await list.getByText("Index the repository").waitFor();
    assert.equal(await list.getByText("Write the summary").isVisible(), false, "reopened, what ended is folded again");
    await page.mouse.click(5, 400);
    await list.waitFor({ state: "detached" });
    console.log("PASS Escape and a press outside close the list, which stops reading");

    await toggle.click();
    await list.getByText("Index the repository").waitFor();
    failing = true;
    await list.getByText("Couldn't refresh: this is the list as it last read").waitFor({ timeout: 8_000 });
    assert.equal(await list.getByText("Index the repository").isVisible(), true, "a failed read keeps the list as it last read");
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "detached" });
    console.log("PASS a failed read keeps the background tasks as they last read");

    // the list goes with the composer it is in: the terminal lens shows none, and reads nothing for it
    failing = false;
    await toggle.click();
    await list.getByText("Index the repository").waitFor();
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await toggle.waitFor({ state: "detached" });
    const leftAt = reads;
    await Bun.sleep(3_500);
    assert.equal(reads, leftAt, "a list whose composer went reads nothing");
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await toggle.waitFor();
    assert.equal(await list.count(), 0, "back in the chat, the list starts closed");
    assert.deepEqual(errors, []);
    console.log("PASS the list closes and stops reading when its composer goes");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-bg-tasks-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkBackgroundTasks(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
