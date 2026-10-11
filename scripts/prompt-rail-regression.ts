import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/** turns per page, as the stand-in server pages them */
const PAGE = 11;
/** prompts in the stand-in transcript; each is answered by one agent turn */
const PROMPTS = 12;

/**
 * The prompt rail over a chat, read from a stand-in transcript of numbered prompts, each answered
 * with an edit, and one message from the fleet that is no prompt: a tick per prompt read, the card
 * of the one pointed at, a click and the keyboard (Mod+Shift+[ and ]) bringing a prompt to the top,
 * a step back past the first prompt loading the page before and landing on the prompt there, the
 * palette finding a prompt by its words, and on a phone the prompts as a list in a sheet. With
 * PROMPT_RAIL_SCREENSHOTS set to a folder, it saves what it saw there.
 */
export async function checkPromptRail(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-prompt-rail-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-prompt-rail" });
  const pane = created.root_pane.pane_id;
  const contexts: BrowserContext[] = [];
  const shots = process.env["PROMPT_RAIL_SCREENSHOTS"];
  try {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
    const open = async (options: Parameters<Browser["newContext"]>[0]): Promise<{ page: Page; errors: string[] }> => {
      const context = await browser.newContext({ locale: "en-US", ...options });
      contexts.push(context);
      await context.addInitScript((id) => {
        if (!localStorage.getItem("herdr-fleet:settings")) localStorage.setItem("herdr-fleet:settings", JSON.stringify({}));
        localStorage.setItem(`herdr-fleet:view:${id}`, "chat");
      }, pane);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/**/conversation?*", (route) => route.fulfill({ json: answer(new URL(route.request().url())) }));
      await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
      await page.locator(".conn-live").waitFor();
      return { page, errors };
    };

    // ---- a desktop ----
    const { page, errors } = await open({ viewport: { width: 1280, height: 800 } });
    const rail = page.locator(".prompt-rail");
    const ticks = rail.locator(".prompt-rail-tick");
    const chat = page.locator(".chat-view");
    // the newest page holds 11 turns: prompts 8 to 12 with their answers, the fleet's message among them
    await page.getByText("prompt 12", { exact: false }).first().waitFor();
    await until(async () => (await ticks.count()) === 5, "a tick for each prompt read, none for the fleet's message");
    assert.equal(await rail.locator(".prompt-rail-earlier").count(), 1, "the pages before are offered");
    assert.equal(await page.locator(".chat-turn-user[data-turn-ts]").count(), 5);
    assert.equal(await ticks.nth(4).getAttribute("aria-current"), "location", "at the end, the newest prompt is the one read");

    // pointing at a tick shows its prompt and what its turn did
    await hover(page, ticks.nth(1));
    const card = page.locator(".prompt-rail-card");
    await card.waitFor();
    assert.match(await card.textContent() ?? "", /prompt 9 /);
    assert.match(await card.textContent() ?? "", /2 \/ 5 · \d\d:\d\d · 1m 30s · 1 edit · file-9\.ts/);
    await save(page, shots, "prompt-rail-desktop");
    console.log("PASS a tick per prompt read, and the card of the one pointed at");

    // a click brings the prompt to the top of the chat, ringed
    await ticks.nth(1).click();
    await until(async () => (await topOf(page, 9)) !== null && Math.abs((await topOf(page, 9))!) < 30, "prompt 9 at the top");
    assert.equal(await page.locator(`.chat-turn-user[data-turn-ts="${tsOf(9)}"]`).getAttribute("data-landed"), "");
    await until(async () => (await ticks.nth(1).getAttribute("aria-current")) === "location", "prompt 9 is the one read");
    console.log("PASS a click brings the prompt to the top of the chat");

    // the keyboard steps on and back, from wherever the focus is
    await chat.click({ position: { x: 20, y: 300 } });
    await page.keyboard.press("Control+Shift+BracketRight");
    await until(async () => Math.abs((await topOf(page, 10)) ?? 999) < 30, "on to prompt 10");
    await page.keyboard.press("Control+Shift+BracketLeft");
    await until(async () => Math.abs((await topOf(page, 9)) ?? 999) < 30, "back to prompt 9");
    console.log("PASS Mod+Shift+] and Mod+Shift+[ step on and back");

    // back past the first prompt read: the page before comes in, and the prompt before is brought up
    await page.keyboard.press("Control+Shift+BracketLeft");
    await until(async () => Math.abs((await topOf(page, 8)) ?? 999) < 30, "back to prompt 8");
    await page.keyboard.press("Control+Shift+BracketLeft");
    await until(async () => Math.abs((await topOf(page, 7)) ?? 999) < 30, "the page before, and prompt 7 at the top");
    assert.ok((await ticks.count()) > 5, "the ticks of the page before joined");
    console.log("PASS a step back past the first prompt loads the page before and lands on the prompt there");

    // the palette finds a prompt by its words
    await page.keyboard.press("Control+Shift+K");
    const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
    await palette.waitFor();
    await palette.getByRole("searchbox").fill("prompt 11");
    const found = palette.locator(".palette-prompt");
    await found.first().waitFor();
    assert.match(await found.first().textContent() ?? "", /prompt 11/);
    await found.first().click();
    await palette.waitFor({ state: "hidden" });
    await until(async () => Math.abs((await topOf(page, 11)) ?? 999) < 30, "the prompt picked in the palette at the top");
    assert.deepEqual(errors, []);
    console.log("PASS the palette finds a prompt by its words and brings it up");

    // ---- a phone: no pointing, so a button opens the prompts as a list ----
    const phone = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const opener = phone.page.locator(".prompt-rail-open");
    await opener.waitFor();
    await save(phone.page, shots, "prompt-rail-phone");
    assert.equal(await phone.page.locator(".prompt-rail-track").isVisible(), false, "no ticks to point at on a touch screen");
    await opener.tap();
    const sheet = phone.page.getByRole("dialog", { name: "Prompts", exact: true });
    await sheet.waitFor();
    assert.equal(await sheet.locator(".prompt-sheet-row").count(), 5);
    await save(phone.page, shots, "prompt-rail-phone-sheet");
    assert.match(await sheet.locator(".prompt-sheet-row.is-reading .prompt-sheet-text").textContent() ?? "", /^prompt 12 /);
    await sheet.locator(".prompt-sheet-row", { hasText: "prompt 9" }).tap();
    await sheet.waitFor({ state: "hidden" });
    await until(async () => Math.abs((await topOf(phone.page, 9)) ?? 999) < 30, "the prompt tapped at the top");
    assert.deepEqual(phone.errors, []);
    console.log("PASS on a phone the prompts open as a list, and a tap brings one up");
  } finally {
    for (const context of contexts) await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

/** prompt n's time, which is its turn's key in the chat */
const tsOf = (n: number): string => new Date(Date.UTC(2026, 9, 11, 9, n * 5)).toISOString();

/**
 * The stand-in transcript: each prompt, then its answer with one edit, ending 90 seconds later and
 * taller than the chat; the fleet's message after prompt 10. 25 turns: the newest page (11) starts
 * at prompt 8, the one before it at prompt 2.
 */
const TURNS = Array.from({ length: PROMPTS }, (_, index) => {
  const n = index + 1;
  const turns: object[] = [
    { role: "user", ts: tsOf(n), parts: [{ kind: "text", text: `prompt ${n} ${"asks for one more change. ".repeat(6)}` }] },
    {
      role: "assistant", ts: tsOf(n), end_ts: new Date(Date.parse(tsOf(n)) + 90_000).toISOString(),
      parts: [
        { kind: "tool", name: "Edit", summary: `file-${n}.ts`, input: JSON.stringify({ file_path: `/repo/src/file-${n}.ts`, old_string: "a", new_string: "b" }), output: "" },
        { kind: "text", text: `done with ${n}.\n\n${"a line of the answer. ".repeat(200)}` },
      ],
    },
  ];
  if (n === 10) turns.push({ role: "user", ts: "fleet-1", parts: [{ kind: "text", text: "[fleet] The thread Fix the retry is ready for review." }] });
  return turns;
}).flat();

/** A page of the stand-in transcript: the newest, the one before a cursor, or from a held start on. */
function answer(url: URL): object {
  const cursorOf = (start: number) => (start === 0 ? null : `c:${start}`);
  const page = (start: number, end: number) => ({ source: "claude-transcript", history_id: "h1", cursor: cursorOf(start), turns: TURNS.slice(start, end) });
  const before = url.searchParams.get("before");
  if (before !== null) {
    const end = Number(before.slice(2));
    return page(Math.max(0, end - PAGE), end);
  }
  const from = url.searchParams.get("from");
  if (from !== null) return page(Number(from.slice(2)), TURNS.length);
  return page(TURNS.length - PAGE, TURNS.length);
}

/** How far under the top of the chat prompt n's row starts, or null when it is not drawn. */
async function topOf(page: Page, n: number): Promise<number | null> {
  return page.evaluate((key) => {
    const view = document.querySelector(".chat-view");
    const row = document.querySelector(`.chat-turn-user[data-turn-ts="${key}"]`);
    return view === null || row === null ? null : row.getBoundingClientRect().top - view.getBoundingClientRect().top;
  }, tsOf(n));
}

/** The mouse over an element: the rail picks the tick nearest the pointer. */
async function hover(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  const box = await target.boundingBox();
  assert.ok(box !== null);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/** With PROMPT_RAIL_SCREENSHOTS set to a folder, what the page shows now is saved there. */
async function save(page: Page, folder: string | undefined, name: string): Promise<void> {
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

async function until(check: () => Promise<boolean>, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) { assert.ok(Date.now() < deadline, label); await Bun.sleep(50); }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-prompt-rail-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, env: { ...process.env, LANG: "en_US.UTF-8", LANGUAGE: "en_US", LC_ALL: "en_US.UTF-8" } });
  try {
    await checkPromptRail(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
