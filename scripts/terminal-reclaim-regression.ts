/**
 * A PC window left in front while the pane is used on a phone never loses its focus, so no focus
 * event says the person came back: a click or a key in its terminal takes the pane back to its own
 * grid. A right-click (the pane menu) leaves it with the phone.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneRead, paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-fleet-reclaim-"));
const cwd = join(root, "pane");
mkdirSync(cwd);
const contexts: BrowserContext[] = [];
let workspace: string | null = null;
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
try {
  const created = await workspaceCreate({ cwd, label: "herdr-fleet-test-reclaim" });
  workspace = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  let asked = 0;
  /** the grid the shell sees */
  const size = async (): Promise<string> => {
    const marker = `size-${++asked}`;
    await paneSendText(paneId, `echo ${marker} $(stty size)`);
    await paneSendKeys(paneId, ["Enter"]);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const text = (await paneRead({ paneId, source: "recent", lines: 80, stripAnsi: true })).text;
      const found = [...text.matchAll(new RegExp(`^${marker} (\\d+ \\d+)\\s*$`, "gm"))].at(-1);
      if (found) return found[1]!;
      await Bun.sleep(100);
    }
    throw new Error(`no ${marker} answer from the pane`);
  };
  const sizeBecomes = async (expected: string, label: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    let now = "";
    while (Date.now() < deadline) { now = await size().catch(() => ""); if (now === expected) return; }
    assert.equal(now, expected, label);
  };
  // both windows stay in use the whole time: neither gets a focus event
  const open = async (options: Parameters<typeof browser.newContext>[0]): Promise<Page> => {
    const context = await browser.newContext({ locale: "en-US", ...options });
    contexts.push(context);
    await context.addInitScript((id) => {
      localStorage.setItem(`herdr-fleet:view:${id}`, "terminal");
      localStorage.setItem("herdr-fleet:settings", JSON.stringify({ defaultView: "terminal", terminalInputMode: "direct" }));
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
      // the grid each resize asks for, to compare with what the shell sees
      const asked: string[] = [];
      (window as unknown as { asked: string[] }).asked = asked;
      const Native = window.WebSocket;
      class Recording extends Native {
        override send(data: string): void { try { const frame = JSON.parse(data); if (frame.type === "resize") asked.push(`${frame.rows} ${frame.cols}`); } catch {} super.send(data); }
      }
      Object.assign(window, { WebSocket: Recording });
    }, paneId);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    await page.waitForFunction(() => (window as unknown as { asked: string[] }).asked.length > 0);
    return page;
  };
  const lastAsked = (page: Page) => page.evaluate(() => (window as unknown as { asked: string[] }).asked.at(-1)!);

  const desktop = await open({ viewport: { width: 1280, height: 800 } });
  const desktopSize = await lastAsked(desktop);
  await sizeBecomes(desktopSize, "the desktop takes the pane at its own size");
  const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phoneSize = await lastAsked(phone);
  assert.notEqual(phoneSize, desktopSize);
  await sizeBecomes(phoneSize, "the phone takes the pane at its own size");

  // a right-click is for the pane menu, not the person taking the pane
  await desktop.locator(".pane-terminal .xterm").click({ button: "right" });
  await Bun.sleep(500);
  assert.equal(await size(), phoneSize, "a right-click in the desktop terminal leaves the pane at the phone's size");
  await desktop.keyboard.press("Escape");
  await desktop.locator(".pane-terminal .xterm").click();
  await sizeBecomes(desktopSize, "a click in the desktop terminal takes the pane back");
  await phone.locator(".pane-terminal .xterm").tap();
  await sizeBecomes(phoneSize, "a tap in the phone terminal takes it again");
  await desktop.locator(".pane-terminal .xterm-helper-textarea").focus();
  await desktop.keyboard.press("Shift");
  await sizeBecomes(desktopSize, "a key in the desktop terminal takes the pane back");
  console.log("PASS a window that kept its focus takes the pane back on a click or a key in its terminal");
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser.close();
  server.stop();
  if (workspace) await workspaceClose(workspace).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
