import { describe, expect, it } from "bun:test";
import type { AgentRun } from "../../shared/fleet.ts";
import type { Machine } from "../../shared/machines.ts";
import type { PaneInfo, TabInfo } from "../../shared/herdr-api.generated.ts";
import { sidePanelModel } from "./sidePanelView.ts";
import { INITIAL_STATE, type UiState } from "./state.ts";

const pane = (id: string, extra: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id: id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: `t-${id}`, focused: false, agent_status: "idle", revision: 1, cwd: "/repo", label: id, ...extra,
});
const tab = (id: string, label: string): TabInfo => ({ tab_id: id, workspace_id: "w1", label, number: 1, pane_count: 1, focused: false, agent_status: "unknown" });
const run = (id: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  id, name: id, role: "worker", agent: "claude", group: "g1", herdrName: `h-${id}`, paneId: `w1:${id}`, cwd: "/repo",
  state: "idle", depth: 0, interactive: true, worktree: false, startedAt: 1, updatedAt: 1, ...extra,
});

function state(panes: PaneInfo[], tabs: TabInfo[], extra: Partial<UiState> = {}): UiState {
  const machine = { id: "local", name: "pc", kind: "local", enabled: true, state: "connected", error: null, snapshot: { panes, tabs, workspaces: [], agents: [], layouts: [], protocol: 1, version: "1" } } as unknown as Machine;
  return { ...INITIAL_STATE, machines: { ...INITIAL_STATE.machines, list: [machine] }, sidePanel: { ...INITIAL_STATE.sidePanel, open: true }, ...extra };
}

describe("the side panel's model", () => {
  it("is about the Pane screen's pane, with nothing open for it yet", () => {
    const model = sidePanelModel(state([pane("w1:p1")], [tab("w1:t1", "main")], { selection: { machineId: "local", paneId: "w1:p1", auto: false } }));
    expect(model.about).toEqual({ machineId: "local", paneId: "w1:p1", title: "w1:p1", cwd: "/repo" });
    expect(model.chat).toEqual({ kind: "none" });
    expect(model.terminal).toEqual({ kind: "none" });
  });

  it("is about nothing with no pane shown", () => {
    expect(sidePanelModel(state([pane("w1:p1")], [])).about).toBeNull();
  });

  it("finds the workspace's terminal in the session tree, but never the pane itself", () => {
    const panes = [pane("w1:p1"), pane("w1:p2", { tab_id: "w1:t2" }), pane("w1:p3", { tab_id: "w1:t3", agent: "claude" })];
    const tabs = [tab("w1:t1", "main"), tab("w1:t2", "terminal"), tab("w1:t3", "terminal")];
    expect(sidePanelModel(state(panes, tabs, { selection: { machineId: "local", paneId: "w1:p1", auto: false } })).terminal).toEqual({ kind: "open", paneId: "w1:p2" });
    expect(sidePanelModel(state(panes, tabs, { selection: { machineId: "local", paneId: "w1:p2", auto: false } })).terminal).toEqual({ kind: "none" });
  });

  it("leaves a terminal the Pane screen has open to that screen's grid", () => {
    const runs = [run("c1", { role: "coordinator", project: "/repo", paneId: "w1:p1" })];
    const panes = [pane("w1:p1"), pane("w1:p2", { tab_id: "w1:t2" })];
    const fleet = (selected: string) => sidePanelModel(state(panes, [tab("w1:t2", "terminal")], {
      screen: "fleet", selection: { machineId: "local", paneId: selected, auto: false },
      runs: { status: "ready", data: runs, again: false }, fleetView: { ...INITIAL_STATE.fleetView, project: "/repo" },
    }));
    expect(fleet("w1:p2").terminal).toEqual({ kind: "in-pane" });
    expect(fleet("w1:p1").terminal).toEqual({ kind: "open", paneId: "w1:p2" });
  });

  it("shows a terminal it opened as opening until the session tree lists it", () => {
    const base = state([pane("w1:p1")], [], { selection: { machineId: "local", paneId: "w1:p1", auto: false } });
    const opened = { ...base, sidePanel: { ...base.sidePanel, terminals: { "w1:p1": { status: "opened" as const, paneId: "w1:p5" } } } };
    expect(sidePanelModel(opened).terminal).toEqual({ kind: "opening" });
    const listed = state([pane("w1:p1"), pane("w1:p5", { tab_id: "w1:t5" })], [], { selection: opened.selection, sidePanel: opened.sidePanel });
    expect(sidePanelModel(listed).terminal).toEqual({ kind: "open", paneId: "w1:p5" });
  });

  it("finds the live side chat about the pane in the runs, the newest", () => {
    const runs = [
      run("old", { role: "side-chat", sideChatOf: "w1:p1", paneId: "w1:p6", startedAt: 1 }),
      run("new", { role: "side-chat", sideChatOf: "w1:p1", paneId: "w1:p7", startedAt: 2 }),
      run("gone", { role: "side-chat", sideChatOf: "w1:p1", paneId: "w1:p8", startedAt: 3, state: "stopped" }),
    ];
    const model = sidePanelModel(state([pane("w1:p1")], [], { selection: { machineId: "local", paneId: "w1:p1", auto: false }, runs: { status: "ready", data: runs, again: false } }));
    expect(model.chat).toEqual({ kind: "open", paneId: "w1:p7", runId: "new", agent: "claude" });
  });

  it("is about the Fleet screen's open thread, else its project's coordinator", () => {
    const runs = [
      run("c1", { role: "coordinator", project: "/repo", paneId: "w1:p1" }),
      run("t1", { role: "lead", project: "/repo", paneId: "w2:p1", group: "g2" }),
    ];
    const fleet = (open: UiState["fleetView"]["open"]) => state([pane("w1:p1"), pane("w2:p1", { workspace_id: "w2" })], [], {
      screen: "fleet", runs: { status: "ready", data: runs, again: false }, fleetView: { ...INITIAL_STATE.fleetView, project: "/repo", open },
    });
    expect(sidePanelModel(fleet(null)).about?.paneId).toBe("w1:p1");
    expect(sidePanelModel(fleet({ kind: "thread", runId: "t1", member: null })).about?.paneId).toBe("w2:p1");
  });
});
