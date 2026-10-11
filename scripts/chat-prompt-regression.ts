import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { t } from "../src/lib/i18n.ts";

const PROMPT: InteractivePrompt = {
  id: "approve-1", agent: "claude", kind: "approval", title: "Allow the edit?", question: "Edit src/app.ts?", body: null,
  options: [{ label: "Yes", description: null }, { label: "No", description: null }], multi_select: false, custom_option_index: null,
};

/**
 * The chat lens reads the waiting prompt while it is open, the page is on screen and the pane
 * is live: a hidden page reads nothing and reads at once when it is back, and the terminal lens
 * shows no card (the chat asks again when it opens).
 */
export async function checkChatPrompt(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-prompt-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-chat-prompt" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "blocked" });
    await context.addInitScript((id) => {
      if (!localStorage.getItem("herdr-fleet:settings")) localStorage.setItem("herdr-fleet:settings", JSON.stringify({}));
      localStorage.setItem(`herdr-fleet:view:${id}`, "chat");
    }, pane);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let reads = 0;
    await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`, async (route) => {
      reads += 1;
      await route.fulfill({ json: { prompt: PROMPT, suggestion: null } });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const card = page.locator(".prompt-card");
    await card.getByText("Edit src/app.ts?").waitFor();
    const setVisible = (visible: boolean) => page.evaluate((shown) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: shown ? "visible" : "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    }, visible);

    await setVisible(false);
    await Bun.sleep(300);
    const hiddenAt = reads;
    await Bun.sleep(4_500);
    assert.equal(reads, hiddenAt, "a hidden page reads no prompt");
    await setVisible(true);
    for (let i = 0; i < 20 && reads === hiddenAt; i++) await Bun.sleep(50);
    assert.ok(reads > hiddenAt, "back on screen, the prompt is read at once");
    await card.waitFor();
    console.log("PASS the chat reads no prompt while the page is hidden, and reads at once when it is back");

    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await card.waitFor({ state: "detached" });
    const terminalAt = reads;
    await Bun.sleep(4_500);
    assert.equal(reads, terminalAt, "the terminal lens reads no prompt");
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await card.getByText("Edit src/app.ts?").waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS the terminal lens shows no prompt card, and the chat asks again when it opens");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A question the agent wrote at the end of its reply gets a card that does not say the pane needs
 * you; a choice fills the message box, and Explain asks the server once (stubbed here: no model is
 * called). The question screen's card shows the person's last message and explains the same way.
 */
export async function checkChatQuestionGuide(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-question-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-chat-question" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
    await context.addInitScript((id) => {
      if (!localStorage.getItem("herdr-fleet:settings")) localStorage.setItem("herdr-fleet:settings", JSON.stringify({}));
      localStorage.setItem(`herdr-fleet:view:${id}`, "chat");
    }, pane);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let prompt: InteractivePrompt | null = null;
    await page.route((url) => url.pathname === "/api/pane/prompt", (route) => route.fulfill({ json: { prompt, suggestion: null } }));
    await page.route((url) => url.pathname === "/api/pane/conversation", (route) => route.fulfill({ json: {
      source: "claude-transcript", history_id: "h1", cursor: null,
      turns: [
        { role: "user", ts: "2026-10-11T00:00:00Z", parts: [{ kind: "text", text: "Add a cache to the user lookup" }] },
        { role: "assistant", ts: "2026-10-11T00:00:05Z", parts: [{ kind: "text", text: "Two ways to keep it.\n\nWhich store should I use?\n1. Redis: fast, one more service\n2. SQLite: no new service" }] },
      ],
    } }));
    const asked: unknown[] = [];
    await page.route((url) => url.pathname === "/api/pane/explain", async (route) => {
      asked.push(route.request().postDataJSON());
      await route.fulfill({ json: { text: "### 推奨\n→ 2. SQLite: サービスを増やさない", model: "haiku", tokens: { input: 1200, output: 80 } } });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();

    const card = page.locator(".asked-card");
    await card.getByText("Which store should I use?").waitFor();
    assert.equal(await card.getByText("Needs you").count(), 0, "a written question does not say the pane needs you");
    await card.getByRole("button", { name: /SQLite/ }).click();
    const box = page.locator(".composer textarea");
    for (let i = 0; i < 40 && (await box.inputValue()) !== "2. SQLite"; i++) await Bun.sleep(50);
    assert.equal(await box.inputValue(), "2. SQLite", "a choice goes into the message box, unsent");
    // with text in the box, the choices wait: nothing the person wrote is replaced
    await card.getByText(t("The message box has text. Send or clear it to pick a choice here.")).waitFor();
    assert.equal(await card.getByRole("button", { name: /Redis/ }).isDisabled(), true, "a choice cannot replace text in the box");
    assert.equal(await box.inputValue(), "2. SQLite");
    await card.getByRole("button", { name: "Explain" }).click();
    await card.locator(".question-explanation").getByText("→ 2. SQLite", { exact: false }).waitFor();
    assert.deepEqual(asked, [{ pane_id: pane, kind: "plain", question: "Which store should I use?", options: [{ label: "Redis", description: "fast, one more service" }, { label: "SQLite", description: "no new service" }] }]);
    const shots = process.env["QUESTION_SCREENSHOTS"];
    if (shots) await page.screenshot({ path: join(shots, "asked-card.png") });
    console.log("PASS a written question's card fills the message box with a choice and explains it once on request");

    prompt = PROMPT;
    const screen = page.locator(".prompt-card:not(.asked-card)");
    await screen.getByText("Edit src/app.ts?").waitFor();
    await card.waitFor({ state: "detached" });
    await screen.locator(".question-instruction-preview").getByText("Add a cache to the user lookup").waitFor();
    await screen.getByRole("button", { name: "Explain" }).click();
    await screen.locator(".question-explanation").waitFor();
    assert.deepEqual(asked[1], { pane_id: pane, kind: "screen", question: "Allow the edit?\nEdit src/app.ts?", options: [{ label: "Yes", description: null }, { label: "No", description: null }] });
    if (shots) await page.screenshot({ path: join(shots, "prompt-card.png") });
    assert.deepEqual(errors, []);
    console.log("PASS the question screen's card shows the last message and explains the question on request");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-chat-prompt-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkChatPrompt(browser, `http://127.0.0.1:${server.port}`);
    await checkChatQuestionGuide(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
