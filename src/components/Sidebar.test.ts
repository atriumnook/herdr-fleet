import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { shownOrder } from "../ui/SidebarPresenter.tsx";
import { EMPTY_TREE, type TreeState } from "../ui/state.ts";
import { Sidebar, type SidebarModel } from "./Sidebar.tsx";
import { t } from "../lib/i18n.ts";

const workspace = (id: string, label: string, number: number): WorkspaceInfo => ({ workspace_id: id, number, label, focused: false, pane_count: 1, tab_count: 1, active_tab_id: `${id}:t1`, agent_status: "idle" } as WorkspaceInfo);
const pane = (id: string, workspaceId: string, label?: string): PaneInfo => ({ pane_id: id, workspace_id: workspaceId, tab_id: `${workspaceId}:t1`, focused: false, cwd: "/w", agent_status: "idle", label } as PaneInfo);
const snapshot = { workspaces: [workspace("w1", "api", 1), workspace("w2", "web", 2)], tabs: [], panes: [pane("w1:p1", "w1", "build"), pane("w2:p1", "w2")] } as unknown as SessionSnapshot;

/** English, as under the app's own provider with an English browser */
function render(tree: Partial<TreeState> = {}, extra: Partial<SidebarModel> = {}): string {
  const model: SidebarModel = { machineId: "local", snapshot, selectedPaneId: null, grouping: "workspace", workspaceOrder: ["w1", "w2"], tree: { ...EMPTY_TREE, ...tree }, ...extra };
  return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(Sidebar, { model, emit: () => {} }) }));
}

describe("Session tree view", () => {
  it("draws the workspaces in the order given, and marks the selected pane", () => {
    const html = render({}, { workspaceOrder: ["w2", "w1"], selectedPaneId: "w1:p1" });
    expect(html.indexOf(">web<")).toBeLessThan(html.indexOf(">build<"));
    expect(html).toContain('class="pane-item is-selected"');
  });

  it("shows the name being typed in place of the title", () => {
    expect(render({ paneRename: { paneId: "w1:p1", label: "deploy" } })).toContain('value="deploy"');
  });

  it("puts an agent's state word at the end of its row, and none on a pane without an agent", () => {
    const withAgent = { ...snapshot, panes: [{ ...pane("w1:p1", "w1", "build"), agent: "claude", agent_status: "working" }, pane("w2:p1", "w2")] } as unknown as SessionSnapshot;
    const rows = render({}, { snapshot: withAgent }).split('<li class="pane-item').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/class="pane-copy">.*<\/span><span class="badge badge-working"[^>]*>Working<\/span><\/div>/);
    expect(rows[1]).not.toContain('class="badge');
    // a state herdr does not know reads nothing: no "—" badge, on a workspace either
    const unknown = { ...withAgent, workspaces: [{ ...snapshot.workspaces[0]!, agent_status: "unknown" }, snapshot.workspaces[1]!] } as unknown as SessionSnapshot;
    expect(render({}, { snapshot: unknown })).not.toContain("badge-unknown");
  });

  it("notes a refused change beside its pane's row, in words", () => {
    expect(render({ failure: { kind: "close", reason: "pane is busy", paneId: "w1:p1", seq: 1 } })).toContain(t("Could not close. {reason}", { reason: "pane is busy" }));
  });
});

describe("the order a PC's workspaces are drawn in", () => {
  it("shows a reorder while herdr's order is still the one it was made on, then herdr's own", () => {
    const order = { basis: ["w1", "w2"], order: ["w2", "w1"] };
    expect(shownOrder(snapshot, order)).toEqual(["w2", "w1"]);
    expect(shownOrder({ ...snapshot, workspaces: [...snapshot.workspaces].reverse() }, order)).toEqual(["w2", "w1"]);
    expect(shownOrder({ ...snapshot, workspaces: [snapshot.workspaces[0]!] }, order)).toEqual(["w1"]);
    expect(shownOrder(snapshot, null)).toEqual(["w1", "w2"]);
  });
});
