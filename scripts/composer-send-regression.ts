import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, WebSocketRoute } from "playwright-core";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const question = (extra: Partial<InteractivePrompt> = {}): InteractivePrompt => ({
  id: "q-1", agent: "codex", kind: "question", title: "Pick one", question: "Which file?", body: null,
  options: [{ label: "a.ts", description: null }, { label: "b.ts", description: null }], multi_select: false, custom_option_index: null, ...extra,
});

/**
 * What the composer does with a message's outcome: a message the pane refused keeps its text and
 * says why; text typed while one is on its way stays, and a sent text changed meanwhile stays with
 * a note; a connection lost mid-send says it was not confirmed. Answers to a waiting prompt: an
 * open Codex question takes no message, an answer out of range is refused, and one the prompt
 * moved past says so.
 */
export async function checkComposerSend(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-composer-send-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-composer-send" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle" });
    await context.addInitScript((id) => {
      if (!localStorage.getItem("herdr-fleet:settings")) localStorage.setItem("herdr-fleet:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`herdr-fleet:view:${id}`, "chat");
    }, pane);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // the pane's answers to a message: refused, held until released, or passed to the server
    let mode: "refuse" | "hold" | "pass" = "refuse";
    let release: (() => void) | null = null;
    let route: WebSocketRoute | null = null;
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      route = socket;
      const upstream = socket.connectToServer();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "submit" && message.pane_id === pane) {
          if (mode === "refuse") { socket.send(JSON.stringify({ type: "submit-result", id: message.id, pane_id: pane, ok: false, code: "input_failed", message: "the pane refused it" })); return; }
          if (mode === "hold") { release = () => socket.send(JSON.stringify({ type: "submit-result", id: message.id, pane_id: pane, ok: true })); return; }
        }
        upstream.send(raw);
      });
      upstream.onMessage((raw) => socket.send(raw));
    });
    let prompt: InteractivePrompt | null = null;
    await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`, (call) => call.fulfill({ json: { prompt, suggestion: null } }));
    await page.route("**/api/pane/prompt/answer", (call) => call.fulfill({ status: 409, json: { error: { code: "prompt_changed", message: "the prompt changed" } } }));
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    const note = page.locator(".composer-note");
    await composer.waitFor();

    await composer.fill("hello");
    await composer.press("Enter");
    await note.filter({ hasText: "Not sent: the pane refused it" }).waitFor();
    assert.equal(await composer.inputValue(), "hello", "a refused message keeps its text");
    console.log("PASS a message the pane refused keeps its text and says why");

    mode = "hold";
    await composer.fill("hello");
    await composer.press("Enter");
    for (let i = 0; i < 100 && release === null; i++) await Bun.sleep(20);
    await composer.press("End");
    await composer.type(" again");
    (release as (() => void) | null)?.();
    release = null;
    await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']")?.value ?? "") === " again");
    await composer.fill("abc");
    await composer.press("Enter");
    for (let i = 0; i < 100 && release === null; i++) await Bun.sleep(20);
    await composer.fill("xbc");
    (release as (() => void) | null)?.();
    release = null;
    await note.filter({ hasText: "Sent as it was." }).waitFor();
    assert.equal(await composer.inputValue(), "xbc", "a sent text changed meanwhile stays as changed");
    console.log("PASS text typed while a message is on its way stays, and a sent text changed meanwhile stays with a note");

    await composer.fill("lost");
    await composer.press("Enter");
    for (let i = 0; i < 100 && release === null; i++) await Bun.sleep(20);
    release = null;
    await (route as WebSocketRoute | null)?.close();
    await note.filter({ hasText: "Not confirmed" }).waitFor();
    assert.equal(await composer.inputValue(), "lost", "a message not confirmed keeps its text");
    await page.locator(".conn-live").waitFor({ timeout: 30_000 });
    mode = "pass";
    console.log("PASS a connection lost mid-send says the message was not confirmed, and keeps it");

    prompt = question({ queued: "open" });
    await page.locator(".prompt-card").waitFor();
    await composer.fill("stop, don't touch prod");
    await composer.press("Enter");
    await note.filter({ hasText: "Codex has a question open in the terminal" }).waitFor();
    assert.equal(await composer.inputValue(), "stop, don't touch prod");
    // a new prompt (another id): the same id keeps the prompt shown
    prompt = question({ id: "q-2" });
    await page.waitForFunction(() => document.querySelector("textarea[aria-label='Message']")?.getAttribute("placeholder")?.startsWith("Answer above") === true);
    await composer.fill("9");
    await composer.press("Enter");
    await note.filter({ hasText: "Choose one of the options above: type 1–2." }).waitFor();
    await composer.fill("1");
    await composer.press("Enter");
    await note.filter({ hasText: "The question on screen changed; check it and answer again." }).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS an open Codex question takes no message, an answer out of range is refused, and one the prompt moved past says so");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-composer-send-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkComposerSend(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
