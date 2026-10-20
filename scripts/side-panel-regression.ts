import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
 * CLI starts) in real herdr panes. On the Pane screen: its terminal opens in a tab labelled
 * terminal in the pane's workspace and takes typing apart from the pane's own grid, and a side
 * chat starts with the pane's screen written for it and shows beside. On the Fleet screen it is
 * about the project's coordinator. On a phone it is a sheet over the screen. With
 * FLEET_SCREENSHOTS set to a folder, it saves what it saw there.
 */
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
    server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir,
      fleet: {
        runtime, usage: new UsageTracker({ file: null }), userDir: join(root, "config"), homeDir: join(root, "home"),
        models: { unknown: async () => undefined, listAll: async () => [] },
        config: () => ({ ...DEFAULT_CONFIG, closeOnSettle: false }),
        agents: () => [
          { name: "coordinator", description: "coordinates", agent: "claude", interactive: true, spawning: true, edits: false, systemPrompt: "", source: "bundled", filePath: "" },
          { name: "side-chat", description: "answers on the side", agent: "claude", interactive: true, edits: false, systemPrompt: "", source: "bundled", filePath: "" },
        ],
      },
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

    // the terminal: a tab labelled terminal in the pane's workspace, typed into apart from the pane
    await panel.getByRole("button", { name: "Terminal", exact: true }).click();
    await panel.getByRole("button", { name: "Open terminal" }).click();
    const grid = panel.locator(".side-panel-terminal .xterm-screen");
    await grid.waitFor();
    const snapshot = await sessionSnapshot();
    const workspace = snapshot.panes.find((pane) => pane.pane_id === subject)!.workspace_id;
    const tab = snapshot.tabs.find((each) => each.workspace_id === workspace && each.label === "terminal");
    assert.ok(tab, "the terminal opens in a tab of the pane's workspace");
    const terminal = snapshot.panes.find((pane) => pane.tab_id === tab.tab_id)!.pane_id;
    await Bun.sleep(500);
    await grid.click();
    await page.keyboard.type("echo side-$((40+2))");
    await page.keyboard.press("Enter");
    await until(async () => (await paneRead({ paneId: terminal, source: "recent", lines: 20 })).text.includes("side-42"), "the side terminal's pane runs what was typed");
    await until(async () => (await panel.locator(".xterm-rows").textContent() ?? "").includes("side-42"), "the side terminal shows its pane's output");
    assert.ok(!(await paneRead({ paneId: subject, source: "recent", lines: 20 })).text.includes("side-42"), "what is typed in the side terminal does not reach the pane");
    assert.ok(!(await page.locator(".terminal-host .xterm-rows").textContent() ?? "").includes("side-42"), "the pane's grid does not show the side terminal's output");
    await save(page, shots, "side-terminal");
    // shown again, the side panel's grid does not take the keyboard from the pane's: a click gives it
    await page.locator(".terminal-host .xterm-screen").click();
    await page.keyboard.press("Control+Shift+L");
    await panel.waitFor({ state: "detached" });
    await page.keyboard.press("Control+Shift+L");
    await panel.locator(".side-panel-terminal .xterm-screen").waitFor();
    await Bun.sleep(500);
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".terminal-host") != null), true, "the pane's grid keeps the keyboard");

    // the side chat: started with its first question, the pane's screen written for it
    await panel.getByRole("button", { name: "Side chat", exact: true }).click();
    await panel.getByLabel("Ask on the side").fill("What did it print?");
    await panel.getByRole("button", { name: "Ask", exact: true }).click();
    await panel.locator(".side-panel-chat .fleet-chat").waitFor();
    const runs = ((await (await fetch(`${origin}/api/fleet/runs`)).json()) as { runs: AgentRun[] }).runs;
    const sideChat = runs.find((run) => run.role === "side-chat");
    assert.equal(sideChat?.sideChatOf, subject);
    const context = join(stateDir, "fleet-results", sideChat.id, "context.md");
    assert.ok(existsSync(context));
    assert.match(readFileSync(context, "utf8"), /subject-42/);
    // the terminal kept its screen behind the chat
    await panel.getByRole("button", { name: "Terminal", exact: true }).click();
    assert.match(await panel.locator(".xterm-rows").textContent() ?? "", /side-42/);
    await panel.getByRole("button", { name: "Side chat", exact: true }).click();
    await save(page, shots, "side-chat");

    // on the Fleet screen it is about the project's coordinator
    const coordinator = await post(origin, "/projects", { task: "hello", cwd: repo });
    await page.locator(".fleet-button").click();
    await page.locator(".fleet-screen").waitFor();
    await page.locator(".fleet-project.is-selected").waitFor();
    await until(async () => (await panel.locator(".side-panel-about").textContent() ?? "").length > 0, "the panel names the coordinator's pane");
    // the Fleet screen lays itself out in the room the panel leaves: the Overview becomes its sheet, the conversation keeps its width
    const conversation = await page.evaluate(() => document.querySelector(".fleet-main")!.getBoundingClientRect().width);
    assert.ok(conversation > 500, `the conversation keeps its width beside the side panel (${conversation}px)`);
    await panel.getByRole("button", { name: "Terminal", exact: true }).click();
    await panel.getByRole("button", { name: "Open terminal" }).click();
    await panel.locator(".side-panel-terminal .xterm-screen").waitFor();
    const fleetSnapshot = await sessionSnapshot();
    const coordinatorWorkspace = fleetSnapshot.panes.find((pane) => pane.pane_id === coordinator.paneId)!.workspace_id;
    assert.ok(fleetSnapshot.tabs.some((each) => each.workspace_id === coordinatorWorkspace && each.label === "terminal"), "the Fleet screen's terminal opens in the coordinator's workspace");
    const fleetTab = fleetSnapshot.tabs.find((each) => each.workspace_id === coordinatorWorkspace && each.label === "terminal")!;
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
    await mobile.locator(".side-panel-chat .fleet-chat").waitFor();
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
