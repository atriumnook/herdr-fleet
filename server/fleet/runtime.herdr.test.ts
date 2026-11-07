import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, workspaceClose, workspaceCreate } from "../herdr/client.ts";
import { HerdrRuntime } from "./runtime.ts";

/** Against the isolated test session: where an agent opens is herdr's to do, so a fake would prove nothing. */
const opened: string[] = [];
const folders: string[] = [];
afterAll(async () => {
  for (const id of opened) await workspaceClose(id).catch(() => undefined);
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

interface Pane { pane_id: string; workspace_id: string; tab_id: string }

describe("HerdrRuntime locations", () => {
  it("opens a caller's helper in a new tab of the caller's workspace, and splits only when asked", async () => {
    const created = await workspaceCreate({ cwd: "/tmp", label: "fleet-contract-caller" });
    const workspaceId = created.workspace.workspace_id;
    opened.push(workspaceId);
    const caller = created.root_pane.pane_id;
    const runtime = new HerdrRuntime();

    const tab = await runtime.createLocation({ cwd: "/tmp", label: "helper", worktree: false, callerPaneId: caller, env: { HERDR_FLEET_GROUP: "contract" } });
    expect(tab.workspaceId).toBe(workspaceId);
    const tabPane = (await herdrRpc<{ pane: Pane }>("pane.get", { pane_id: tab.paneId })).pane;
    expect(tabPane.workspace_id).toBe(workspaceId);
    expect(tabPane.tab_id).not.toBe(created.root_pane.tab_id);

    const split = await runtime.createLocation({ cwd: "/tmp", label: "beside", worktree: false, callerPaneId: caller, direction: "down", env: {} });
    expect((await herdrRpc<{ pane: Pane }>("pane.get", { pane_id: split.paneId })).pane.tab_id).toBe(created.root_pane.tab_id);
  });

  it("puts a thread's worktree where it is told: inside the repository", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "fleet-contract-repo-")));
    folders.push(repo);
    Bun.spawnSync(["git", "init", "-q", repo]);
    Bun.spawnSync(["git", "-C", repo, "-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init"]);
    const path = join(repo, ".herdr-fleet", "worktrees", "t1");
    const location = await new HerdrRuntime().createLocation({ cwd: repo, label: "thread", worktree: true, branch: "fleet/t1", path, env: {} });
    if (location.workspaceId) opened.push(location.workspaceId);
    expect(location.cwd).toBe(path);
    expect(existsSync(join(path, ".git"))).toBe(true);
  });
});

describe("HerdrRuntime screen", () => {
  it("regression: reads the live bottom with its colors while the pane is scrolled up into its history", async () => {
    const created = await workspaceCreate({ cwd: "/tmp", label: "fleet-contract-screen" });
    opened.push(created.workspace.workspace_id);
    const pane = created.root_pane.pane_id;
    // a CLI on the normal screen, with its input at the bottom and a dim placeholder in it
    await herdrRpc("pane.send_text", { pane_id: pane, text: "for i in $(seq 1 80); do echo line $i; done; printf '\\033[2mdim placeholder\\033[0m\\n'\n" });
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "pi", state: "idle" });
    const runtime = new HerdrRuntime();
    for (let i = 0; i < 40 && !(await runtime.screen(pane)).includes("line 80"); i++) await Bun.sleep(50);
    // a drag or the wheel in the web terminal leaves the viewport on old output
    await herdrRpc("pane.scroll", { pane_id: pane, offset_from_bottom: 40 });
    const screen = await runtime.screen(pane);
    expect(screen).toContain("\u001b[2mdim placeholder");
  });
});
