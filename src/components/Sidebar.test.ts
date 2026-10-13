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
  const model: SidebarModel = { machineId: "local", snapshot, selectedPaneId: null, workspaceOrder: ["w1", "w2"], tree: { ...EMPTY_TREE, ...tree }, ...extra };
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

  it("puts an agent's state dot at the end of its row, and none on a pane without an agent", () => {
    const withAgent = { ...snapshot, panes: [{ ...pane("w1:p1", "w1", "build"), agent: "claude", agent_status: "working" }, pane("w2:p1", "w2")] } as unknown as SessionSnapshot;
    const rows = render({}, { snapshot: withAgent }).split('<li class="pane-item').slice(1);
    expect(rows).toHaveLength(2);
    // the dot alone at the row's end: the word is its tooltip and is read out, not drawn
    expect(rows[0]).toMatch(/class="pane-copy">.*<\/span><span class="badge badge-working is-dot"[^>]*title="Agent Working"><span class="visually-hidden">Working<\/span><\/span><\/div>/);
    expect(rows[1]).not.toContain('class="badge');
    // a state herdr does not know reads nothing: no "—" badge, on a workspace either
    const unknown = { ...withAgent, workspaces: [{ ...snapshot.workspaces[0]!, agent_status: "unknown" }, snapshot.workspaces[1]!] } as unknown as SessionSnapshot;
    expect(render({}, { snapshot: unknown })).not.toContain("badge-unknown");
  });

  it("notes a refused change beside its pane's row, in words", () => {
    expect(render({ failure: { kind: "close", reason: "pane is busy", paneId: "w1:p1", seq: 1 } })).toContain(t("Could not close. {reason}", { reason: "pane is busy" }));
  });
});

describe("projects in the session tree", () => {
  const inRepo = (each: WorkspaceInfo, root: string, checkout = root): WorkspaceInfo => ({ ...each, worktree: { repo_key: `${root}/.git`, repo_name: root.split("/").pop()!, repo_root: root, checkout_path: checkout, is_linked_worktree: checkout !== root } });
  const three = {
    ...snapshot,
    workspaces: [inRepo(workspace("w1", "api", 1), "/git/app"), workspace("w2", "web", 2), inRepo(workspace("w3", "thread", 3), "/git/app", "/git/app/.herdr-fleet/worktrees/a")],
    panes: [pane("w1:p1", "w1", "build"), pane("w2:p1", "w2"), pane("w3:p1", "w3", "lead")],
  } as unknown as SessionSnapshot;

  it("heads the workspaces of one repository with the project, in the place of its first one", () => {
    const html = render({}, { snapshot: three, workspaceOrder: ["w1", "w2", "w3"] });
    expect(html.match(/class="project-group/g)).toHaveLength(1);
    expect(html).toContain('data-project="/git/app"');
    expect(html).toContain('aria-label="New session in app"');
    // the project draws first, both its workspaces inside, then the workspace outside Git
    const contents = html.slice(html.indexOf('class="project-contents"'));
    expect(contents.indexOf(">build<")).toBeLessThan(contents.indexOf(">lead<"));
    expect(contents.indexOf(">lead<")).toBeLessThan(contents.indexOf(">web<"));
    expect(html.slice(html.indexOf(">web<")).includes("project-group")).toBe(false);
  });

  it("draws a lone workspace of a repository without a project heading, and marks a linked worktree", () => {
    const lone = { ...three, workspaces: [three.workspaces[2]!, three.workspaces[1]!], panes: [pane("w3:p1", "w3", "lead"), pane("w2:p1", "w2")] } as unknown as SessionSnapshot;
    const html = render({}, { snapshot: lone, workspaceOrder: ["w3", "w2"] });
    expect(html).not.toContain("project-group");
    expect(html).toContain('title="Worktree /git/app/.herdr-fleet/worktrees/a"');
  });

  it("folds a project to its heading, as stored for this PC and repository", () => {
    // bun has no localStorage: one key stored, as the browser keeps it
    const stored = new Map([["herdr-fleet:project-collapsed:local:/git/app/.git", "1"]]);
    Object.assign(globalThis, { localStorage: { getItem: (key: string) => stored.get(key) ?? null } });
    try {
      const html = render({}, { snapshot: three, workspaceOrder: ["w1", "w2", "w3"] });
      expect(html).toContain('class="project-group is-collapsed"');
      expect(html).not.toContain(">build<");
      expect(html).toContain(">web<");
    } finally { delete (globalThis as { localStorage?: unknown }).localStorage; }
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
