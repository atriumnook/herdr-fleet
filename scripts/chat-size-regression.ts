import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { herdrRpc, paneRead, paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * The screen the person looks at sizes the pane: a browser's terminal lens while its window has
 * the focus and the page is in front. It gives the pane back to herdr's layout when the focus
 * leaves (herdr's own terminal window), when the chat lens covers it, when the page leaves the
 * screen, and when it closes: a browser left open must not hold it at another size, or herdr's
 * own screen shows the top left of a larger grid and loses the prompt under its bottom edge. A
 * grid a browser does not size is drawn in its settings' font too, and scrolls where it is larger
 * than the space. The size is the one the pane's own shell reports (`stty size`), not
 * what either browser thinks.
 */
export async function checkFocusedViewSizesPane(browser: Browser, origin: string): Promise<void> {
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

    // a window losing the focus to another (herdr's terminal), or getting it back
    const focus = (page: Page, focused: boolean) => page.evaluate((focused) => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
      window.dispatchEvent(new Event(focused ? "focus" : "blur"));
    }, focused);
    const sizeBecomes = async (accept: (size: string) => boolean, label: string): Promise<string> => {
      const deadline = Date.now() + 15_000;
      // a question typed while the grid changes can be lost as the shell redraws its prompt: ask again
      const ask = () => size().catch(() => "");
      let now = await ask();
      while (!accept(now) && Date.now() < deadline) now = await ask();
      assert.ok(accept(now), `${label} (the shell sees ${now})`);
      return now;
    };
    // how the grid sits in the terminal's space: the font it is drawn at, and how much of the space it takes
    const fitted = (page: Page) => page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".pane-terminal")!;
      const xterm = host.querySelector<HTMLElement>(".xterm")!;
      const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
      const style = getComputedStyle(xterm);
      const width = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      return {
        font: parseFloat(getComputedStyle(host.querySelector(".xterm-rows")!).fontSize),
        fill: Math.max(screen.offsetWidth / width, screen.offsetHeight / height),
        overflows: host.scrollWidth > host.clientWidth + 1 || host.scrollHeight > host.clientHeight + 1,
      };
    });
    const fitsWhen = async (page: Page, accept: (now: Awaited<ReturnType<typeof fitted>>) => boolean, label: string) => {
      const deadline = Date.now() + 5000;
      let now = await fitted(page);
      while (!accept(now) && Date.now() < deadline) {
        await Bun.sleep(100);
        now = await fitted(page);
      }
      assert.ok(accept(now), `${label} (${JSON.stringify(now)})`);
      return now;
    };

    const own = await size();
    const ownRows = Number(own.split(" ")[0]);
    const ownCols = Number(own.split(" ")[1]);
    const desktop = await open({ viewport: { width: 1280, height: 800 } }, { defaultView: "terminal" });
    await attached(desktop);
    // the window has the focus: its terminal lens sizes the pane to itself, at the settings' 13px
    const desktopSize = await sizeBecomes((now) => now !== own, "the focused desktop sizes the pane to itself");
    await drawsGrid(desktop, Number(desktopSize.split(" ")[0]), "the desktop draws its own grid");
    await fitsWhen(desktop, (now) => now.font === 13 && !now.overflows, "the desktop's own grid is drawn at the settings' font");
    console.log(`PASS the focused desktop sizes the pane to itself: ${desktopSize}`);

    // herdr's terminal takes the focus: the pane is herdr's again, and the desktop draws herdr's
    // grid at the settings' font; herdr lays a lone pane out at 120x40, which a 1280x800 window
    // holds only in a font smaller than 13px, so it scrolls
    await focus(desktop, false);
    await sizeBecomes((now) => now === own, "a desktop that loses the focus gives the pane back");
    await drawsGrid(desktop, ownRows, "the unfocused desktop draws herdr's grid");
    await fitsWhen(desktop, (now) => now.font === 13 && now.overflows, "a space too small for herdr's grid at 13px scrolls");
    // a larger window holds it at the settings' font too, with room to spare: the pane keeps herdr's grid
    await desktop.setViewportSize({ width: 1920, height: 1200 });
    const roomy = await fitsWhen(desktop, (now) => now.font === 13 && !now.overflows, "a larger window draws herdr's grid at the settings' font, not larger");
    assert.equal(await size(), own, "resizing an unfocused window leaves herdr's grid");
    console.log(`PASS an unfocused desktop leaves the pane at its own ${own} and draws it at the settings' 13px: scrolling when too small, ${Math.round(roomy.fill * 100)}% of a larger window`);

    // the desktop gets the focus back: it sizes the pane again, at its new size
    await focus(desktop, true);
    await sizeBecomes((now) => now !== own && now !== desktopSize, "a desktop that gets the focus back sizes the pane again");
    await fitsWhen(desktop, (now) => now.font === 13 && !now.overflows, "the desktop draws its own grid at the settings' font again");
    await focus(desktop, false);
    await sizeBecomes((now) => now === own, "the desktop gives the pane back again");
    console.log("PASS a desktop that gets the focus back sizes the pane again");

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
    const terminalLens = async (): Promise<void> => {
      await phone.locator('button[title^="Live terminal"]').tap();
      await phone.locator(".terminal-stack.is-chat").waitFor({ state: "detached" });
    };
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

    // the focused desktop sizes the pane again; a phone that takes it meanwhile has it, and when the
    // phone lets go the desktop, still in front with the focus, takes it back
    await focus(desktop, true);
    const focusedSize = await sizeBecomes((now) => now !== own, "the focused desktop sizes the pane again");
    const another = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { defaultView: "terminal" });
    await sizeBecomes((now) => Number(now.split(" ")[1]) < ownCols, "a phone's terminal lens takes the pane from the focused desktop");
    await another.context().close();
    await sizeBecomes((now) => now === focusedSize, "the focused desktop takes the pane back when the phone lets go");
    console.log(`PASS the focused desktop takes the pane back (${focusedSize}) when a phone that took it lets go`);

    // the desktop's chat lens, focus and all, gives the pane back, and its hidden screen keeps the pane's grid
    await desktop.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await desktop.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    await sizeBecomes((now) => now === own, "the desktop's chat lens gives the pane back");
    await drawsGrid(desktop, ownRows, "the desktop's chat lens draws its hidden screen for the pane's grid");
    console.log(`PASS the desktop's chat lens gives the pane back its own ${own}`);
  } finally {
    for (const context of contexts) await context.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
