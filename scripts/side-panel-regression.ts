import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { paneRead, paneSendKeys, paneSendText, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";
import { DEFAULT_CONFIG } from "../server/fleet/config.ts";
import type { AgentRuntime } from "../server/fleet/runtime.ts";
import type { AgentRun } from "../server/fleet/types.ts";
import { UsageTracker } from "../server/fleet/usage.ts";

/**
 * The side panel in a real browser, over a server whose fleet runs on a stand-in runtime (no agent
 * CLI starts) in real herdr panes, and whose side chats run a stand-in claude that answers in
 * stream-json. On the Pane screen: a terminal opens by itself in a tab labelled terminal in the
 * pane's workspace, a second one beside it, each typed into apart from the pane's own grid; a side
 * chat is handed the pane's screen, asked twice in one process, and started over. The desktop
 * app's keys put the keyboard in each. On the Fleet screen it is about the project's coordinator,
 * and `/btw` in the conversation's box asks it. On a phone it is a sheet over the screen. With
 * FLEET_SCREENSHOTS set to a folder, it saves what it saw there.
 */

/** A claude that answers each question in stream-json, and writes what it was given to `log`. */
function fakeClaude(root: string, log: string): string {
  const path = join(root, "fake-claude");
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
const print = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let rest = "";
for await (const chunk of process.stdin) {
  rest += chunk;
  let end;
  while ((end = rest.indexOf("\\n")) >= 0) {
    const line = JSON.parse(rest.slice(0, end));
    rest = rest.slice(end + 1);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ sent: line }) + "\\n");
    if (line.type !== "user") continue;
    const question = line.message.content[0].text.split("Question:\\n").at(-1);
    print({ type: "stream_event", event: { type: "message_start" } });
    print({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Answer" } } });
    print({ type: "assistant", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Answer to: " + question }] } });
    print({ type: "result", subtype: "success", is_error: false, result: "Answer to: " + question });
  }
}
`);
  chmodSync(path, 0o755);
  return path;
}

const logLines = (log: string): Array<{ argv?: string[]; cwd?: string; sent?: { type: string; message?: { content: { text: string }[] } } }> =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];

export async function checkSidePanel(browser: Browser): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-side-panel-"));
  const shots = process.env["FLEET_SCREENSHOTS"];
  const workspaces: string[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const realPane = async (label: string) => {
      const created = await workspaceCreate({ cwd: repo, label: `herdr-fleet-test-${label.replace(/\W+/g, "-")}` });
      workspaces.push(created.workspace.workspace_id);
      return created.root_pane.pane_id;
    };
    const runtime: AgentRuntime = {
      createLocation: async (options) => ({ paneId: await realPane(options.label), cwd: options.cwd }),
      start: async () => "idle",
      prompt: async () => "idle",
      get: async () => "idle",
      read: async () => "", screen: async () => "",
      closePane: async () => {}, interrupt: async () => {}, focus: async () => {}, reportMetadata: async () => {},
    };
    const stateDir = join(root, "state");
    const log = join(root, "claude.log");
    server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir,
      fleet: {
        runtime, usage: new UsageTracker({ file: null }), userDir: join(root, "config"), homeDir: join(root, "home"),
        models: { unknown: async () => undefined, listAll: async () => [] },
        config: () => ({ ...DEFAULT_CONFIG, closeOnSettle: false }),
        agents: () => [
          { name: "coordinator", description: "coordinates", agent: "claude", interactive: true, spawning: true, edits: false, systemPrompt: "", source: "bundled", filePath: "" },
        ],
      },
      sideChats: { command: fakeClaude(root, log) },
    });
    const origin = `http://127.0.0.1:${server.port}`;

    // the pane the panel is about: a shell that printed something to ask about
    const subject = await realPane("side-subject");
    await Bun.sleep(500);
    await paneSendText(subject, "echo subject-$((6*7))");
    await paneSendKeys(subject, ["Enter"]);
    await until(async () => (await paneRead({ paneId: subject, source: "recent", lines: 20 })).text.includes("subject-42"), "the pane printed");

    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    await desktop.addInitScript(() => localStorage.setItem("herdr-fleet:settings", JSON.stringify({ defaultView: "terminal" })));
    const page = await desktop.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(subject)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".terminal-host .xterm-rows").waitFor();

    // the header's button and the shortcut both show it
    await page.locator(".side-panel-button").click();
    const panel = page.locator(".side-panel");
    await panel.waitFor();
    await page.keyboard.press("Control+Shift+L");
    await panel.waitFor({ state: "detached" });
    await page.keyboard.press("Control+Shift+L");
    await panel.waitFor();
    const beside = await page.evaluate(() => {
      const host = document.querySelector(".terminal-host")!.getBoundingClientRect();
      const side = document.querySelector(".side-panel")!.getBoundingClientRect();
      return side.left >= host.right - 1 && side.width > 300;
    });
    assert.ok(beside, "on a desktop the side panel stands right of the pane");
    // its edge is dragged to widen it, and the width stays for the next page
    const before = await panel.evaluate((node) => node.getBoundingClientRect().width);
    const edge = await page.locator(".side-panel-resize").boundingBox();
    await page.mouse.move(edge!.x + 2, edge!.y + 100);
    await page.mouse.down();
    await page.mouse.move(edge!.x - 98, edge!.y + 100, { steps: 4 });
    await page.mouse.up();
    const widened = await panel.evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(widened > before + 80, `dragging the edge widens the panel (${before} -> ${widened})`);

    // the terminal: picked, it opens by itself in a tab labelled terminal in the pane's workspace
    await panel.getByRole("button", { name: "Terminal", exact: true }).click();
    const grid = panel.locator(".side-panel-terminal .xterm-screen");
    await grid.waitFor();
    const terminalsOf = async () => {
      const snapshot = await sessionSnapshot();
      const workspace = snapshot.panes.find((pane) => pane.pane_id === subject)!.workspace_id;
      const tabs = new Set(snapshot.tabs.filter((each) => each.workspace_id === workspace && each.label === "terminal").map((each) => each.tab_id));
      return snapshot.panes.filter((pane) => tabs.has(pane.tab_id)).map((pane) => pane.pane_id);
    };
    const [terminal] = await terminalsOf();
    assert.ok(terminal, "the terminal opens in a tab of the pane's workspace");
    await Bun.sleep(500);
    await grid.click();
    await page.keyboard.type("echo side-$((40+2))");
    await page.keyboard.press("Enter");
    await until(async () => (await paneRead({ paneId: terminal, source: "recent", lines: 20 })).text.includes("side-42"), "the side terminal's pane runs what was typed");
    await until(async () => (await panel.locator(".xterm-rows").textContent() ?? "").includes("side-42"), "the side terminal shows its pane's output");
    assert.ok(!(await paneRead({ paneId: subject, source: "recent", lines: 20 })).text.includes("side-42"), "what is typed in the side terminal does not reach the pane");
    assert.ok(!(await page.locator(".terminal-host .xterm-rows").textContent() ?? "").includes("side-42"), "the pane's grid does not show the side terminal's output");
    await save(page, shots, "side-terminal");
    // a second terminal beside it, shown at once; the first comes back with its screen, and the second closes
    await panel.getByRole("button", { name: "New terminal" }).click();
    await until(async () => (await terminalsOf()).length === 2, "a second terminal opens in another tab");
    await panel.getByRole("button", { name: "Terminal 2" }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Terminal 2" }).getAttribute("aria-pressed"), "true");
    await panel.getByRole("button", { name: "Terminal 1" }).click();
    await until(async () => (await panel.locator(".xterm-rows").textContent() ?? "").includes("side-42"), "the first terminal shows its screen again");
    await panel.getByRole("button", { name: "Terminal 2" }).click();
    await panel.getByRole("button", { name: "Close terminal" }).click();
    await until(async () => (await terminalsOf()).length === 1, "the second terminal closes");
    await panel.getByRole("button", { name: "Terminal 2" }).waitFor({ state: "detached" });
    // shown again, the side panel's grid does not take the keyboard from the pane's: a click gives it
    await page.locator(".terminal-host .xterm-screen").click();
    await page.keyboard.press("Control+Shift+L");
    await panel.waitFor({ state: "detached" });
    await page.keyboard.press("Control+Shift+L");
    await panel.locator(".side-panel-terminal .xterm-screen").waitFor();
    await Bun.sleep(500);
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".terminal-host") != null), true, "the pane's grid keeps the keyboard");
    // the desktop app's keys: Ctrl+` puts the keyboard in the terminal, and takes the panel away when it shows it
    await page.keyboard.press("Control+`");
    await panel.waitFor({ state: "detached" });
    await page.keyboard.press("Control+`");
    await panel.locator(".side-panel-terminal .xterm-screen").waitFor();
    await until(async () => page.evaluate(() => document.activeElement?.closest(".side-panel-terminal") != null), "Ctrl+` puts the keyboard in the side terminal");
    // Ctrl+; does so for the side chat's box
    await page.keyboard.press("Control+;");
    await until(async () => page.evaluate(() => document.activeElement?.closest(".side-chat-box") != null), "Ctrl+; puts the keyboard in the side chat's box");

    // the side chat: a shell keeps no conversation, so it is handed the pane's screen
    await page.keyboard.type("What did it print?");
    await page.keyboard.press("Enter");
    await panel.locator(".side-chat .chat-view").getByText("Answer to: What did it print?").waitFor();
    const first = logLines(log);
    assert.equal(first.filter((line) => line.argv).length, 1);
    const started = first.find((line) => line.argv)!;
    assert.equal(started.cwd, repo, "the side chat runs in the pane's folder");
    assert.ok(started.argv!.includes("--no-session-persistence") && started.argv!.join(" ").includes("--setting-sources user"));
    const asked = first.find((line) => line.sent?.type === "user")!.sent!.message!.content[0]!.text;
    assert.match(asked, /^\[Side chat\]/);
    assert.match(asked, /subject-42/, "the side chat is handed the pane's screen");
    // it says it was handed the pane's conversation, not a session of its own to go on from
    assert.ok(await panel.locator(".side-chat-source").isVisible());
    // the next question goes to the same process, as typed
    await panel.getByLabel("Ask on the side").fill("And then?");
    await panel.getByRole("button", { name: "Ask", exact: true }).click();
    await panel.getByText("Answer to: And then?").waitFor();
    const second = logLines(log);
    assert.equal(second.filter((line) => line.argv).length, 1, "one process answers both");
    assert.equal(second.filter((line) => line.sent?.type === "user").at(-1)!.sent!.message!.content[0]!.text, "And then?");
    // the terminal kept its screen behind the chat
    await panel.getByRole("button", { name: "Terminal", exact: true }).click();
    assert.match(await panel.locator(".xterm-rows").textContent() ?? "", /side-42/);
    await panel.getByRole("button", { name: "Side chat", exact: true }).click();
    await save(page, shots, "side-chat");
    // a reload finds it on the server
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.keyboard.press("Control+;");
    await panel.getByText("Answer to: And then?").waitFor();
    // a new side chat ends this one: nothing of it is kept
    await panel.getByRole("button", { name: "New side chat" }).click();
    await panel.getByText("Answer to: And then?").waitFor({ state: "detached" });

    // on the Fleet screen it is about the project's coordinator, and `/btw` in its box asks it there
    const coordinator = await post(origin, "/projects", { task: "hello", cwd: repo });
    await page.locator(".fleet-button").click();
    await page.locator(".fleet-screen").waitFor();
    await page.locator(".fleet-project.is-selected").waitFor();
    await until(async () => (await panel.locator(".side-panel-about").textContent() ?? "").length > 0, "the panel names the coordinator's pane");
    // the Fleet screen lays itself out in the room the panel leaves: the Overview becomes its sheet, the conversation keeps its width
    const conversation = await page.evaluate(() => document.querySelector(".fleet-main")!.getBoundingClientRect().width);
    assert.ok(conversation > 500, `the conversation keeps its width beside the side panel (${conversation}px)`);
    const box = page.locator(".fleet-main .composer-text");
    await box.fill("/btw what is the plan?");
    await box.press("Enter");
    await panel.getByText("Answer to: what is the plan?").waitFor();
    assert.equal(await box.inputValue(), "", "the box is left as a send leaves it");
    await panel.getByRole("button", { name: "Terminal", exact: true }).click();
    await panel.locator(".side-panel-terminal .xterm-screen").waitFor();
    const fleetSnapshot = await sessionSnapshot();
    const coordinatorWorkspace = fleetSnapshot.panes.find((pane) => pane.pane_id === coordinator.paneId)!.workspace_id;
    const fleetTab = fleetSnapshot.tabs.find((each) => each.workspace_id === coordinatorWorkspace && each.label === "terminal");
    assert.ok(fleetTab, "the Fleet screen's terminal opens in the coordinator's workspace");
    const fleetTerminal = fleetSnapshot.panes.find((pane) => pane.tab_id === fleetTab.tab_id)!.pane_id;
    await until(async () => (await panel.locator(".xterm-rows").textContent() ?? "").includes("zsh") || (await panel.locator(".xterm-rows").textContent() ?? "").includes("$"), "the Fleet screen's terminal shows its shell");
    await panel.locator(".side-panel-terminal .xterm-screen").click();
    await page.keyboard.type("echo fleet-$((50+5))");
    await page.keyboard.press("Enter");
    await until(async () => (await paneRead({ paneId: fleetTerminal, source: "recent", lines: 20 })).text.includes("fleet-55"), "the Fleet screen's terminal runs what was typed");
    await until(async () => (await panel.locator(".xterm-rows").textContent() ?? "").includes("fleet-55"), "the Fleet screen's terminal shows its output");
    await save(page, shots, "side-fleet");
    assert.deepEqual(errors, []);

    // a window too narrow for a third column: the panel is a sheet over the right of the screen
    await page.setViewportSize({ width: 1024, height: 800 });
    const overlay = await page.evaluate(() => {
      const box = document.querySelector(".side-panel")!.getBoundingClientRect();
      return { position: getComputedStyle(document.querySelector(".side-panel")!).position, right: box.right, width: box.width, sideways: document.documentElement.scrollWidth - window.innerWidth };
    });
    assert.deepEqual({ position: overlay.position, sideways: overlay.sideways }, { position: "fixed", sideways: 0 });
    assert.ok(overlay.right >= 1000 && overlay.width <= 440, "a sheet along the right edge");
    await save(page, shots, "side-narrow");

    // a phone: a sheet over the screen, nothing pushed sideways
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
    const mobile = await phone.newPage();
    const mobileErrors: string[] = [];
    mobile.on("pageerror", (error) => mobileErrors.push(error.message));
    await mobile.goto(`${origin}/?pane=${encodeURIComponent(subject)}`);
    await mobile.locator(".conn-live").waitFor();
    await mobile.locator(".side-panel-button").click();
    await mobile.locator(".side-panel").waitFor();
    const sheet = await mobile.evaluate(() => {
      const box = document.querySelector(".side-panel")!.getBoundingClientRect();
      return { left: box.left, right: box.right, sideways: document.documentElement.scrollWidth - window.innerWidth };
    });
    assert.ok(sheet.left <= 1 && sheet.right >= 389, "on a phone the side panel covers the screen's width");
    assert.equal(sheet.sideways, 0);
    await mobile.locator(".side-chat-box textarea").waitFor();
    await save(mobile, shots, "side-phone");
    await mobile.locator(".side-panel-scrim").click({ position: { x: 4, y: 4 }, force: true }).catch(() => undefined);
    assert.deepEqual(mobileErrors, []);
    await phone.close();
  } finally {
    server?.stop();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

async function post(origin: string, path: string, body: unknown): Promise<AgentRun> {
  const response = await fetch(`${origin}/api/fleet${path}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-fleet": "1" }, body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text());
  return ((await response.json()) as { run: AgentRun }).run;
}

async function until(check: () => Promise<boolean>, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(100);
  }
}

async function save(page: Page, folder: string | undefined, name: string): Promise<void> {
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    await checkSidePanel(browser);
    console.log("side panel: ok");
  } finally {
    await browser.close();
  }
}
