/**
 * Text a program colored for a dark background stays readable on the light theme (Claude Code
 * writes its question titles as truecolor white).
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const state = mkdtempSync(join(tmpdir(), "terminal-colors-links-"));
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** WCAG's relative luminance of an `rgb(r, g, b)` color */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/\d+/g) ?? []).slice(0, 3).map((part) => {
    const c = Number(part) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

try {
  // Given: a pane that wrote a truecolor-white title and a web address
  const program = join(state, "screen.mjs");
  writeFileSync(program, `process.stdout.write(${JSON.stringify("\x1b[2J\x1b[H\x1b[1m\x1b[38;2;255;255;255mWHITE_TITLE\x1b[0m\r\nsee https://example.test/page now\r\nSCREEN_READY\r\n")});
setInterval(() => {}, 1 << 30);
`);
  const made = await workspaceCreate({ cwd: state, label: "herdr-fleet-test-colors-links" });
  workspaces.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const ready = herdrRpc("pane.wait_for_output", {
    pane_id: pane, source: "visible", match: { type: "substring", value: "SCREEN_READY" }, timeout_ms: 10000,
  }, undefined, 12000);
  await herdrRpc("pane.send_input", { pane_id: pane, text: `exec ${quote(process.execPath)} ${quote(program)}`, keys: ["enter"] });
  await ready;

  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(state, "server") });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript((id) => {
    localStorage.setItem(`herdr-fleet:view:${id}`, "terminal");
    localStorage.setItem("herdr-fleet:settings", JSON.stringify({ theme: "light" }));
    // what the page asks the browser to open, and how
    const opened: { via: string; url: string; features?: string; target?: string }[] = [];
    (window as unknown as { opened: typeof opened }).opened = opened;
    window.open = ((url?: string | URL, target?: string, features?: string) => { opened.push({ via: "open", url: String(url), features, target }); return null; }) as typeof window.open;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { opened.push({ via: "link", url: this.href, target: this.target }); };
  }, pane);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(".pane-terminal .xterm-rows", { hasText: "SCREEN_READY" }).waitFor();

  // When: the title is drawn, its color is read against the terminal's background
  const drawn = await page.evaluate(() => {
    const rows = document.querySelector<HTMLElement>(".pane-terminal .xterm-rows")!;
    const span = [...rows.querySelectorAll("span")].find((node) => node.textContent?.includes("WHITE_TITLE"))!;
    const viewport = document.querySelector<HTMLElement>(".pane-terminal .xterm-viewport")!;
    return { color: getComputedStyle(span).color, background: getComputedStyle(viewport).backgroundColor };
  });
  console.log(JSON.stringify(drawn));
  // Then: it reads at 4.5:1 or more, not white on the light background
  assert.ok(contrast(drawn.color, drawn.background) >= 4.5, `the white title is drawn ${drawn.color} on ${drawn.background}`);
  console.log("PASS text a program colored white stays readable on the light theme");

  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
