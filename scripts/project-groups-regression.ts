/**
 * The sidebar's projects in a real browser against an isolated herdr. Run after `bun run build`.
 * HERDR_TEST_SESSION picks the herdr session (default herdr-fleet-test); CHROME_PATH the browser;
 * UI_EVIDENCE_DIR keeps a screenshot of the sidebar.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { HerdrError, herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-project-regression-")));
// only what this run made: never a resident workspace or another run's
const ownedWorkspaces: string[] = [];
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createServer> | undefined;

function git(cwd: string, ...args: string[]): void {
  const done = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args]);
  assert.equal(done.exitCode, 0, `git ${args.join(" ")}: ${done.stderr.toString()}`);
}

const paneSelector = (paneId: string): string => `.pane-select[title^=${JSON.stringify(`${paneId} —`)}]`;

try {
  assert.notEqual(process.env.HERDR_TEST_LIVE, "1", "Live-session mode is forbidden");
  assert.notEqual(process.env.HERDR_TEST_MODE, "unit", "This regression requires isolated herdr");
  const { testSocketPath } = await import("./test-herdr.ts");
  assert.equal(process.env.HERDR_SOCKET, testSocketPath(), "test-herdr must select its isolated socket");

  // Given a repository with a workspace at its root, one in a subfolder and a fleet-style linked
  // worktree; a second repository with one workspace; and a folder outside Git.
  const app = join(root, "app");
  const solo = join(root, "solo");
  const lone = join(root, "lone");
  for (const folder of [join(app, "sub"), solo, lone]) mkdirSync(folder, { recursive: true });
  for (const repo of [app, solo]) { git(repo, "init", "-q", "-b", "main"); git(repo, "commit", "-q", "--allow-empty", "-m", "init"); }
  const make = async (cwd: string, label: string) => {
    const created = await workspaceCreate({ cwd, label });
    ownedWorkspaces.push(created.workspace.workspace_id);
    return { workspaceId: created.workspace.workspace_id, paneId: created.root_pane.pane_id };
  };
  const main = await make(app, "project-regression-main");
  const sub = await make(join(app, "sub"), "project-regression-sub");
  const outside = await make(lone, "project-regression-lone");
  const single = await make(solo, "project-regression-solo");
  const thread = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("worktree.create", {
    cwd: app, branch: "fleet/regression", label: "project-regression-thread", focus: false, path: join(app, ".herdr-fleet", "worktrees", "regression"),
  });
  ownedWorkspaces.push(thread.workspace.workspace_id);
  // a second pane gives the main workspace a heading of its own inside the project
  await herdrRpc("pane.split", { target_pane_id: main.paneId, direction: "down", focus: false, cwd: app });

  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, stateDir: join(root, "state"), codexHome: join(root, "codex") });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addInitScript(() => {
    if (!localStorage.getItem("herdr-fleet:settings")) localStorage.setItem("herdr-fleet:settings", JSON.stringify({ alertsOn: false }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));

  // When the sidebar draws, Then the repository's three workspaces sit under one project heading.
  await page.goto(`${origin}/?pane=${encodeURIComponent(outside.paneId)}`);
  const project = page.locator(`.project-group[data-project=${JSON.stringify(app)}]`);
  await project.waitFor();
  assert.equal(await page.locator(".project-group").count(), 1, "only the repository with several workspaces has a heading");
  for (const paneId of [main.paneId, sub.paneId, thread.root_pane.pane_id]) {
    assert.equal(await project.locator(paneSelector(paneId)).count(), 1, `${paneId} is drawn in its project`);
  }
  for (const paneId of [outside.paneId, single.paneId]) {
    assert.equal(await page.locator(`.project-group ${paneSelector(paneId)}`).count(), 0, `${paneId} has no project heading`);
  }
  assert.equal(await project.locator(".project-name").textContent(), "app");
  assert.equal(await project.locator(".project-toggle .workspace-number").textContent(), "3");
  assert.equal(await project.locator(`.worktree-mark[title=${JSON.stringify(`Worktree ${join(app, ".herdr-fleet", "worktrees", "regression")}`)}]`).count(), 1, "the thread's worktree is marked");
  assert.equal(await page.getByRole("button", { name: "Sidebar grouping" }).count(), 0);
  const evidence = process.env.UI_EVIDENCE_DIR;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.locator(".sidebar-list").first().screenshot({ path: join(evidence, "project-groups.png"), animations: "disabled" });
  }
  console.log("PASS a repository's workspaces, its subfolder and worktree too, share one project heading");

  // When the project is folded and the page reloads, Then the fold stays; selecting a pane in it
  // opens it again.
  const toggle = project.locator(".project-toggle");
  await toggle.click();
  await project.locator(".project-toggle[aria-expanded='false']").waitFor();
  assert.equal(await project.locator(".project-contents").count(), 0);
  await page.reload();
  await project.locator(".project-toggle[aria-expanded='false']").waitFor();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), `herdr-fleet:project-collapsed:local:${join(app, ".git")}`), "1");
  await page.goto(`${origin}/?pane=${encodeURIComponent(sub.paneId)}`);
  await page.locator(`${paneSelector(sub.paneId)}[aria-current="true"]`).waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "selecting a pane in a folded project opens it");
  console.log("PASS a project's fold survives a reload, and a selection inside it opens it");

  // When a session starts from the project's +, Then the dialog starts at the repository root, asks
  // for a name, and the new workspace lands after the project's last one in herdr's own order.
  await project.getByRole("button", { name: "New session in app" }).click();
  const dialog = page.getByRole("dialog", { name: /^New session/ });
  assert.equal(await dialog.getByLabel(/^Directory/).inputValue(), app);
  // a sentence, so it reads in the browser's language (src/lib/i18n.ja.ts)
  await dialog.getByText(/^app (already has 3 workspaces\.|にはすでに 3 個の Workspace があります。)/).waitFor();
  await dialog.getByLabel(/^Name/).fill("project-regression-new");
  const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/workspace/create"));
  await dialog.getByRole("button", { name: "Start session", exact: true }).click();
  const created = await (await createdResponse).json() as { workspace_id: string; pane_id: string };
  ownedWorkspaces.push(created.workspace_id);
  await dialog.waitFor({ state: "hidden" });
  await project.locator(`${paneSelector(created.pane_id)}[aria-current="true"]`).waitFor();
  assert.equal(await project.locator(".project-toggle .workspace-number").textContent(), "4");
  const order = (await sessionSnapshot()).workspaces.map((workspace) => workspace.workspace_id);
  const lastOfProject = Math.max(...[main.workspaceId, sub.workspaceId, thread.workspace.workspace_id].map((id) => order.indexOf(id)));
  assert.equal(order.indexOf(created.workspace_id), lastOfProject + 1, "herdr keeps the new workspace with its project");
  console.log("PASS a session started from a project opens at its root and joins it in herdr's order");

  assert.deepEqual(errors, [], "no browser page errors");
} finally {
  const cleanupErrors: unknown[] = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  try { server?.stop(); } catch (error) { cleanupErrors.push(error); }
  // a main checkout closes only after its linked worktrees: the newest first
  for (const id of [...ownedWorkspaces].reverse()) {
    try { await workspaceClose(id); } catch (error) {
      if (!(error instanceof HerdrError && error.code === "workspace_not_found")) cleanupErrors.push(error);
    }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    console.error(new AggregateError(cleanupErrors, "Project regression cleanup failed"));
    process.exitCode = 1;
  }
}
