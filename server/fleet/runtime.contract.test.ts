import { afterAll, describe, expect, it } from "bun:test";
import { herdrRpc, workspaceClose, workspaceCreate } from "../herdr/client.ts";
import { HerdrRuntime } from "./runtime.ts";

/** Against the isolated test session: where an agent opens is herdr's to do, so a fake would prove nothing. */
const opened: string[] = [];
afterAll(async () => { for (const id of opened) await workspaceClose(id).catch(() => undefined); });

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
});
