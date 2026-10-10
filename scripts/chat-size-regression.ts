import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { herdrRpc, paneRead, paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * A pane keeps the size herdr lays it out at, but while a phone's terminal lens is in front: a
 * browser left open must not hold it at another size, or herdr's own screen shows the top of a
 * taller grid and loses the prompt under its bottom edge. A desktop's terminal lens and a phone's
 * chat lens leave the pane at its size; the phone's terminal lens sizes it to the phone, and gives
 * it back when the chat lens covers it, when the page leaves the screen, and when it closes. The
 * size is the one the pane's own shell reports (`stty size`), not what either browser thinks.
 */
export async function checkPhoneSizesPaneInFront(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-size-"));
  const cwd = join(root, "pane");
  mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-fleet-test-chat-size" });
  const paneId = created.root_pane.pane_id;
  const contexts: BrowserContext[] = [];
  try {
    // an agent pane opens in the chat lens on a phone; the shell under it answers `stty size`
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    let asked = 0;
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
    const open = async (options: Parameters<Browser["newContext"]>[0], settings: object): Promise<Page> => {
      const context = await browser.newContext({ locale: "en-US", ...options });
      contexts.push(context);
      await context.addInitScript((stored) => {
        localStorage.setItem("herdr-fleet:settings", JSON.stringify(stored));
        // every frame this page's socket sends and receives, to wait on the server's answers
        const frames: { dir: "in" | "out"; type: string; keep_size?: boolean }[] = [];
        (window as unknown as { frames_: typeof frames }).frames_ = frames;
        const Native = window.WebSocket;
        class Recording extends Native {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener("message", (event) => { try { frames.push({ dir: "in", type: JSON.parse(String(event.data)).type }); } catch {} });
          }
          override send(data: string): void { try { const frame = JSON.parse(data); frames.push({ dir: "out", type: frame.type, keep_size: frame.keep_size }); } catch {} super.send(data); }
        }
        Object.assign(window, { WebSocket: Recording });
      }, settings);
      const page = await context.newPage();
      await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
      await page.locator(".conn-live").waitFor();
      return page;
    };
    // the server answers an attach with input-ready: once it is in, the attach has done whatever
    // it does to the grid
    const attached = (page: Page) => page.waitForFunction(() => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.some((f) => f.dir === "in" && f.type === "input-ready"), undefined, { timeout: 15_000 });
    const sent = (page: Page) => page.evaluate(() => (window as unknown as { frames_: { dir: string; type: string; keep_size?: boolean }[] }).frames_.filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize")));
    // xterm's DOM renderer keeps one element a row
    const drawnRows = (page: Page) => page.locator(".pane-terminal .xterm-rows > div").count();
    const drawsGrid = async (page: Page, rows: number, label: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (await drawnRows(page) !== rows && Date.now() < deadline) await Bun.sleep(100);
      assert.equal(await drawnRows(page), rows, label);
    };

    const own = await size();
    const ownRows = Number(own.split(" ")[0]);
    const desktop = await open({ viewport: { width: 1280, height: 800 } }, { defaultView: "terminal" });
    await attached(desktop);
    assert.equal(await size(), own, "the desktop's terminal lens leaves the pane's grid");
    await drawsGrid(desktop, ownRows, "the desktop's terminal lens draws the pane's grid");
    console.log(`PASS a desktop's terminal lens leaves the pane at its own ${own}`);

    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { defaultView: "chat" });
    await phone.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    await attached(phone);
    // the chat lens attaches without driving the grid, and sends no resize of its own
    assert.deepEqual(await sent(phone), [{ dir: "out", type: "attach", keep_size: true }]);
    assert.equal(await size(), own, "the phone's chat lens leaves the pane's grid");
    if (process.env.UI_EVIDENCE_DIR) await desktop.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "chat-size-desktop.png") });
    console.log(`PASS a phone's chat lens leaves the pane at its own ${own}`);

    // the phone's terminal lens sizes the pane to the phone, and the desktop draws the phone's grid:
    // on a phone the lens switch shows no label, the button is known by its title
    const sizeBecomes = async (accept: (size: string) => boolean, label: string): Promise<string> => {
      const deadline = Date.now() + 10_000;
      let now = await size();
      while (!accept(now) && Date.now() < deadline) now = await size();
      assert.ok(accept(now), `${label} (the shell sees ${now})`);
      return now;
    };
    const terminalLens = async (): Promise<void> => {
      await phone.locator('button[title^="Live terminal"]').tap();
      await phone.locator(".terminal-stack.is-chat").waitFor({ state: "detached" });
    };
    const ownCols = Number(own.split(" ")[1]);
    await terminalLens();
    const phoneSize = await sizeBecomes((now) => Number(now.split(" ")[1]) < ownCols, "the phone's terminal lens sizes the pane to the phone");
    const phoneRows = Number(phoneSize.split(" ")[0]);
    await drawsGrid(desktop, phoneRows, "the desktop draws the grid the phone gave the pane");
    await drawsGrid(phone, phoneRows, "the phone draws its own grid");
    if (process.env.UI_EVIDENCE_DIR) await phone.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "chat-size-phone-terminal.png") });
    console.log(`PASS the phone's terminal lens sizes the pane to ${phoneSize}`);

    // the chat lens covers it: the pane is herdr's size again
    await phone.locator('button[title^="Chat transcript"]').tap();
    await phone.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    await sizeBecomes((now) => now === own, "the phone's chat lens gives the pane its size back");
    await drawsGrid(desktop, ownRows, "the desktop draws the pane's grid again");
    console.log(`PASS the phone's chat lens gives the pane back its own ${own}`);

    // the page leaves the screen (another app, the screen locked): the pane is herdr's size again,
    // and the phone takes it once it is back in front
    await terminalLens();
    await sizeBecomes((now) => now === phoneSize, "the phone's terminal lens sizes the pane again");
    const visibility = (state: "hidden" | "visible") => phone.evaluate((state) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
    await visibility("hidden");
    await sizeBecomes((now) => now === own, "a phone that leaves the screen gives the pane its size back");
    await visibility("visible");
    await sizeBecomes((now) => now === phoneSize, "a phone back in front sizes the pane again");
    console.log("PASS a phone that leaves the screen gives the pane back, and takes it on its return");

    // the phone closes: the pane is herdr's size again
    await phone.context().close();
    await sizeBecomes((now) => now === own, "a phone that closes gives the pane its size back");
    console.log("PASS a phone that closes gives the pane back");

    // the desktop's chat lens resizes nothing, and its hidden screen keeps the pane's grid
    await desktop.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await desktop.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    await drawsGrid(desktop, ownRows, "the desktop's chat lens draws its hidden screen for the pane's grid");
    assert.equal(await size(), own, "entering the chat lens resizes nothing");
    console.log(`PASS the desktop's chat lens keeps the pane's own ${own}`);
  } finally {
    for (const context of contexts) await context.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
