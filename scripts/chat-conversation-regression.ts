import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/** turns per page, as the stand-in server pages them */
const PAGE = 10;

/**
 * The chat's conversation, read from a stand-in transcript of numbered turns: the newest page
 * polled, earlier pages added above on request, the turns between joined in order when the
 * newest page moves past them, an unchanged answer (304) leaving the page alone, a replaced
 * transcript (a new history id, or a cursor it no longer knows) starting over, "New messages"
 * for a reader scrolled up, and nothing read while the page is hidden.
 */
export async function checkChatConversation(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-conversation-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-chat-conversation" });
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

    // the stand-in transcript: `count` turns, each a few lines so the chat scrolls
    let history = "h1";
    let count = 30;
    const requests: string[] = [];
    const turn = (index: number) => ({ role: "user", ts: `t${index + 1}`, parts: [{ kind: "text", text: `turn ${index + 1}\n\n${"line of text. ".repeat(12)}` }] });
    // a cursor is where a page starts; one past the transcript's end is one it no longer knows (409)
    const cursorOf = (start: number) => (start === 0 ? null : `c:${start}`);
    const indexOf = (cursor: string): number | null => {
      const index = Number(cursor.slice(2));
      return Number.isInteger(index) && index <= count ? index : null;
    };
    await page.route("**/api/**/conversation?*", async (route) => {
      const url = new URL(route.request().url());
      const query = ["from", "before", "since"].filter((key) => url.searchParams.has(key)).map((key) => `${key}=${url.searchParams.get(key)}`).join("&");
      requests.push(query || "newest");
      const answer = (start: number, end: number) => ({ source: "claude-transcript", history_id: history, cursor: cursorOf(start), turns: Array.from({ length: end - start }, (_, offset) => turn(start + offset)) });
      const before = url.searchParams.get("before");
      const from = url.searchParams.get("from");
      let body;
      if (before !== null) {
        const end = indexOf(before);
        const since = url.searchParams.get("since");
        const floor = since === null ? 0 : indexOf(since);
        if (end === null || floor === null) { await route.fulfill({ status: 409, json: { error: { code: "history_changed", message: "history changed" } } }); return; }
        body = answer(Math.max(floor, end - PAGE), end);
      } else if (from !== null) {
        const start = indexOf(from);
        if (start === null) { await route.fulfill({ status: 409, json: { error: { code: "history_changed", message: "history changed" } } }); return; }
        // the newest page moved past the held start: it starts later, and the turns between are paged
        body = count - start > PAGE ? answer(count - PAGE, count) : answer(start, count);
      } else body = answer(Math.max(0, count - PAGE), count);
      const etag = `"${history}-${count}-${query}"`;
      if (route.request().headers()["if-none-match"] === etag) { await route.fulfill({ status: 304, headers: { etag } }); return; }
      await route.fulfill({ json: body, headers: { etag } });
    });

    const shown = (): Promise<number[]> => page.locator(".chat-transcript").evaluate((node) => [...node.textContent!.matchAll(/turn (\d+)/g)].map((match) => Number(match[1])));
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
    const until = async (check: () => Promise<boolean>, label: string, ms = 10_000) => {
      const deadline = Date.now() + ms;
      while (!(await check())) { assert.ok(Date.now() < deadline, label); await Bun.sleep(50); }
    };
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    await until(async () => JSON.stringify(await shown()) === JSON.stringify(range(21, 30)), "the newest page");

    // an earlier page goes in above, and the newest is polled from where it started
    await page.locator(".chat-older").click();
    await until(async () => JSON.stringify(await shown()) === JSON.stringify(range(11, 30)), "the earlier page above");
    await until(async () => requests.at(-1) === `from=c:20`, "polled from the held start");
    console.log("PASS an earlier page goes in above the newest, which is polled from where it started");

    // the newest page moves past the held start: the turns between join, in order, once each
    count = 45;
    await until(async () => JSON.stringify(await shown()) === JSON.stringify(range(11, 45)), "the turns between joined");
    assert.ok(requests.includes(`before=c:35&since=c:20`) && requests.includes(`before=c:25&since=c:20`), `paged between: ${requests.join(" ")}`);
    await until(async () => requests.at(-1) === `from=c:35`, "polled from the new start");
    console.log("PASS the turns between the held start and the newest page join in order, once each");

    // an unchanged answer leaves the page alone
    const mutations = await watchMutations(page);
    const quietFrom = requests.length;
    await until(async () => requests.length >= quietFrom + 2, "two polls answered unchanged", 8_000);
    assert.equal(await mutations(), 0, "an unchanged answer changes nothing on the page");
    console.log("PASS an unchanged answer (304) leaves the chat as it is");

    // a reader scrolled up is told of a new turn instead of being moved
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight / 2; node.dispatchEvent(new Event("scroll")); });
    count = 46;
    await page.locator(".chat-new-messages", { hasText: "New messages" }).waitFor();
    await page.locator(".chat-new-messages", { hasText: "New messages" }).click();
    await page.locator(".chat-new-messages").waitFor({ state: "detached" });
    console.log("PASS a reader scrolled up is told of new messages, and taken to them");

    // the transcript replaced, its cursors still valid: the new history id alone drops the earlier pages
    history = "h2";
    await until(async () => JSON.stringify(await shown()) === JSON.stringify(range(37, 46)), "a new history starts from its newest page");
    // a cursor the transcript no longer knows (409) starts over too
    await page.locator(".chat-older").click();
    await until(async () => (await shown())[0] === 27, "an earlier page of the new history");
    count = 12;
    await until(async () => JSON.stringify(await shown()) === JSON.stringify(range(3, 12)), "a cursor the transcript no longer knows starts over");
    console.log("PASS a replaced transcript (a new history id, or a cursor it no longer knows) starts over");

    // a hidden page reads nothing, and reads at once when it is back
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    await Bun.sleep(300);
    const hiddenAt = requests.length;
    await Bun.sleep(4_500);
    assert.equal(requests.length, hiddenAt, "a hidden page reads no conversation");
    count = 13;
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    await until(async () => (await shown()).at(-1) === 13, "read at once on return", 1_500);
    assert.deepEqual(errors, []);
    console.log("PASS a hidden page reads no conversation, and reads at once when it is back");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Counts what changes under the transcript from now on. */
async function watchMutations(page: Page): Promise<() => Promise<number>> {
  await page.locator(".chat-transcript").evaluate((node) => {
    const seen = { count: 0 };
    (window as unknown as { chatMutations: typeof seen }).chatMutations = seen;
    new MutationObserver((records) => { seen.count += records.length; }).observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  return () => page.evaluate(() => (window as unknown as { chatMutations: { count: number } }).chatMutations.count);
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-conversation-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkChatConversation(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
