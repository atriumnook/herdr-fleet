import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * What the composer completes: the pane's slash commands under a typed `/`, chosen from the
 * keyboard (Enter completes instead of sending; Escape puts the menu away), and the files under
 * a typed `@`, searched as the name is typed.
 */
export async function checkComposerCompletion(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fleet-composer-completion-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-fleet-test-composer-completion" });
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
    const searches: string[] = [];
    let submits = 0;
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((raw) => {
        if (JSON.parse(String(raw)).type === "submit") submits += 1;
        upstream.send(raw);
      });
      upstream.onMessage((raw) => socket.send(raw));
    });
    await page.route("**/api/pane/commands?*", (route) => route.fulfill({ json: { commands: [
      { name: "review", description: "Review the changes", source: "builtin" },
      { name: "release", description: "Cut a release", source: "project" },
    ] } }));
    await page.route("**/api/pane/files?*", async (route) => {
      const query = new URL(route.request().url()).searchParams.get("q") ?? "";
      searches.push(query);
      await route.fulfill({ json: { files: ["src/app.ts", "src/ui/state.ts"].filter((file) => file.includes(query)) } });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();

    const commands = page.getByRole("listbox", { name: "Slash commands", exact: true });
    await composer.fill("/re");
    await commands.getByRole("option").first().waitFor();
    assert.equal(await commands.getByRole("option").count(), 2);
    await composer.press("Escape");
    await commands.waitFor({ state: "detached" });
    await composer.fill("/rel");
    await commands.getByRole("option", { name: /release/ }).waitFor();
    await composer.press("Enter");
    await commands.waitFor({ state: "detached" });
    assert.equal(await composer.inputValue(), "/release ", "Enter completes the command");
    assert.equal(submits, 0, "a completion sends nothing");
    console.log("PASS slash commands complete from the keyboard, and Escape puts the menu away");

    const files = page.getByRole("listbox", { name: "Files", exact: true });
    await composer.fill("look at @ui");
    await files.getByRole("option", { name: /src\/ui\/state\.ts/ }).waitFor();
    assert.equal(searches.at(-1), "ui");
    await composer.press("Enter");
    assert.equal(await composer.inputValue(), "look at @src/ui/state.ts ");
    assert.deepEqual(errors, []);
    console.log("PASS files under a typed @ are searched and complete into the message");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-fleet-composer-completion-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
  try {
    await checkComposerCompletion(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
