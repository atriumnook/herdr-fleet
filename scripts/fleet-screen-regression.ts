import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";
import { DEFAULT_CONFIG } from "../server/fleet/config.ts";
import type { AgentRuntime } from "../server/fleet/runtime.ts";
import type { AgentState } from "../server/fleet/types.ts";
import { UsageTracker } from "../server/fleet/usage.ts";

/**
 * The Fleet screen in a real browser, over a server whose fleet runs on a stand-in runtime (no
 * agent CLI starts): the header button opens it, runs show in the order they need the person,
 * usage capsules show their windows and a cooldown that can be ended, a run's detail opens on a
 * sheet, and "Open pane" takes the person to the run's real herdr pane. With FLEET_SCREENSHOTS set
 * to a folder, it saves what it saw there.
 */
export async function checkFleetScreen(browser: Browser): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-fleet-screen-"));
  const shots = process.env["FLEET_SCREENSHOTS"];
  const workspaces: string[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  try {
    mkdirSync(join(root, "pane"));
    const created = await workspaceCreate({ cwd: join(root, "pane"), label: "herdr-fleet-test-fleet-screen" });
    workspaces.push(created.workspace.workspace_id);
    const realPane = created.root_pane.pane_id;

    // impl works in the real pane; review stops at a question; scout finishes its turn at once,
    // which the fleet notices once its grace period after the prompt has passed
    const stateOf = (name: string): AgentState => (name.includes("scout") ? "idle" : "working");
    let panes = 0;
    const runtime: AgentRuntime = {
      createLocation: async (options) => ({ paneId: options.label === "impl" ? realPane : `w99:p${++panes}`, cwd: options.cwd }),
      start: async (options) => (options.name.includes("review") ? "blocked" : "idle"),
      prompt: async (name) => stateOf(name),
      get: async (name) => stateOf(name),
      read: async () => "",
      closePane: async () => {}, interrupt: async () => {}, focus: async () => {}, reportMetadata: async () => {},
    };
    const now = Date.now();
    const usage = new UsageTracker({ file: null });
    usage.record("claude", { readAt: now, windows: [{ name: "5h", usedPercent: 92, resetsAt: now + 3_600_000 }, { name: "weekly", usedPercent: 28, resetsAt: now + 86_400_000 }] });
    usage.record("codex", { readAt: now, windows: [{ name: "5h", usedPercent: 12, resetsAt: now + 3_600_000 }, { name: "weekly", usedPercent: 64, resetsAt: now + 86_400_000 }] });
    usage.noteFailure("cursor", undefined, "Error: rate limit exceeded", 60);
    server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"),
      fleet: {
        runtime, usage,
        config: () => ({ ...DEFAULT_CONFIG, closeOnSettle: false }),
        agents: () => [
          { name: "worker", description: "implements", agent: "pi", systemPrompt: "", source: "bundled", filePath: "" },
          { name: "reviewer", description: "reviews", agent: "codex", model: "gpt-6", systemPrompt: "", source: "bundled", filePath: "" },
          { name: "scout", description: "looks", agent: "agy", model: "gemini-3.8-flash-low", systemPrompt: "", source: "bundled", filePath: "" },
        ],
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const spawn = async (role: string, name: string) => {
      const response = await fetch(`${origin}/api/fleet/spawn`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-fleet": "1" }, body: JSON.stringify({ role, name, task: "t", cwd: root, group: "fleet-e2e" }) });
      assert.equal(response.status, 201, await response.clone().text());
    };
    await spawn("worker", "impl");
    await spawn("reviewer", "review");
    await spawn("scout", "scout");

    const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
    await desktop.addInitScript(() => localStorage.setItem("herdr-fleet:settings", JSON.stringify({ language: "en" })));
    const page = await desktop.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator(".conn-live").waitFor();

    // the button names how many runs wait on the person, and opens the screen
    const button = page.locator(".fleet-button");
    await page.locator(".fleet-button-count", { hasText: "1" }).waitFor();
    assert.equal(await button.getAttribute("aria-label"), "Fleet: 1 waiting on you");
    await button.click();
    const screen = page.locator(".fleet-screen");
    await screen.waitFor();
    // scout's settle comes after the grace period: wait for it to reach Done
    await page.locator(".fleet-section.tone-done").waitFor();
    const headings = await screen.locator(".fleet-section-head h2").allTextContents();
    assert.deepEqual(headings, ["Waiting on you", "Working", "Done"]);
    assert.equal(await screen.locator(".fleet-run.is-prominent .fleet-run-name b").textContent(), "review");
    assert.match(await screen.locator(".fleet-capsule.level-low").textContent() ?? "", /claude/);
    await save(page, shots, "fleet-desktop-dark");

    // a cooldown ends from its capsule
    const cooling = screen.locator(".fleet-capsule.is-cooling");
    assert.match(await cooling.textContent() ?? "", /cursor/);
    await cooling.getByRole("button", { name: "Clear" }).click();
    await screen.locator(".fleet-capsule.is-cooling").waitFor({ state: "detached" });

    // a run's detail opens in front, and closes
    await screen.locator(".fleet-run-name", { hasText: "review" }).click();
    const sheet = page.locator(".fleet-sheet");
    await sheet.waitFor();
    assert.match(await sheet.textContent() ?? "", /The fleet never answers a question; only a person does\./);
    assert.match(await sheet.textContent() ?? "", /codex:gpt-6/);
    await save(page, shots, "fleet-detail-dark");
    await sheet.getByRole("button", { name: "Close" }).click();
    await sheet.waitFor({ state: "detached" });

    // Open pane takes the person to the run's own pane, and the pane under the screen was live all along
    await screen.locator(".fleet-run", { hasText: "impl" }).getByRole("button", { name: "Open pane" }).click();
    await screen.waitFor({ state: "detached" });
    await page.waitForURL(origin + "/");
    assert.equal(await page.locator(".pane-layer").getAttribute("inert"), null);
    await page.locator(".context", { hasText: "herdr-fleet-test-fleet-screen" }).waitFor();
    assert.deepEqual(errors, []);
    await desktop.close();

    for (const theme of shots ? ["light"] : []) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
      await context.addInitScript((t) => localStorage.setItem("herdr-fleet:settings", JSON.stringify({ language: "en", theme: t })), theme);
      const light = await context.newPage();
      await light.goto(origin);
      await light.locator(".fleet-button").click();
      await light.locator(".fleet-section.tone-done").waitFor();
      await save(light, shots, `fleet-desktop-${theme}`);
      await context.close();
    }

    // on a phone the switch is a tab bar along the bottom, and the screen still reads top to bottom
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
    await phone.addInitScript(() => localStorage.setItem("herdr-fleet:settings", JSON.stringify({ language: "en" })));
    const mobile = await phone.newPage();
    const mobileErrors: string[] = [];
    mobile.on("pageerror", (error) => mobileErrors.push(error.message));
    await mobile.goto(origin);
    await mobile.locator(".fleet-button").click();
    await mobile.locator(".fleet-section.tone-done").waitFor();
    const ornament = await mobile.locator(".fleet-ornament").boundingBox();
    assert.ok(ornament && ornament.width > 330, `the ornament spans the phone: ${JSON.stringify(ornament)}`);
    const overflow = await mobile.evaluate(() => document.querySelector(".fleet-scroll")!.scrollWidth - document.querySelector(".fleet-scroll")!.clientWidth);
    assert.equal(overflow, 0, "nothing scrolls sideways on a phone");
    await save(mobile, shots, "fleet-phone-dark");
    assert.deepEqual(mobileErrors, []);
    await phone.close();
  } finally {
    server?.stop();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
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
    await checkFleetScreen(browser);
    console.log("fleet screen: ok");
  } finally {
    await browser.close();
  }
}
