import { describe, expect, it } from "bun:test";
import type { AgentRun } from "../../shared/fleet.ts";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import type { PaneInfo, TabInfo } from "../../shared/herdr-api.generated.ts";
import type { SideChatSnapshot } from "../../shared/side-chat.ts";
import { sideChatTurns, sidePanelModel } from "./sidePanelView.ts";
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
    expect(model.about).toEqual({ machineId: "local", paneId: "w1:p1", title: "w1:p1", cwd: "/repo", key: "w1:p1" });
    expect(model.chatHere).toBe(true);
    expect(model.terminals).toEqual({ list: [], shown: null, inPane: false, opening: false, failed: null });
  });

  it("is about nothing with no pane shown, and has no side chat for a pane on another PC", () => {
    expect(sidePanelModel(state([pane("w1:p1")], [])).about).toBeNull();
    const machine = { id: "pc2", name: "pc2", kind: "remote", enabled: true, state: "connected", error: null, snapshot: { panes: [pane("w1:p1")], tabs: [], workspaces: [], agents: [] } } as unknown as Machine;
    const remote = { ...state([], []), machines: { ...INITIAL_STATE.machines, list: [machine] }, selection: { machineId: "pc2", paneId: "w1:p1", auto: false } };
    expect(sidePanelModel(remote)).toMatchObject({ about: { key: paneStorageId("pc2", "w1:p1") }, chatHere: false });
  });

  it("finds the workspace's terminals in the session tree, but never the pane itself, and shows the one picked", () => {
    const panes = [pane("w1:p1"), pane("w1:p2", { tab_id: "w1:t2" }), pane("w1:p3", { tab_id: "w1:t3", agent: "claude" }), pane("w1:p4", { tab_id: "w1:t4" })];
    const tabs = [tab("w1:t1", "main"), tab("w1:t2", "terminal"), tab("w1:t3", "terminal"), tab("w1:t4", "terminal")];
    const selected = state(panes, tabs, { selection: { machineId: "local", paneId: "w1:p1", auto: false } });
    expect(sidePanelModel(selected).terminals).toMatchObject({ list: ["w1:p2", "w1:p4"], shown: "w1:p2" });
    const picked = { ...selected, sidePanel: { ...selected.sidePanel, shownTerminal: { "w1:p1": "w1:p4" } } };
    expect(sidePanelModel(picked).terminals.shown).toBe("w1:p4");
    // one picked that closed gives way to the first
    const gone = { ...selected, sidePanel: { ...selected.sidePanel, shownTerminal: { "w1:p1": "w1:p9" } } };
    expect(sidePanelModel(gone).terminals.shown).toBe("w1:p2");
    expect(sidePanelModel(state(panes, tabs, { selection: { machineId: "local", paneId: "w1:p2", auto: false } })).terminals.list).toEqual(["w1:p4"]);
  });

  it("leaves a terminal the Pane screen has open to that screen's grid", () => {
    const runs = [run("c1", { role: "coordinator", project: "/repo", paneId: "w1:p1" })];
    const panes = [pane("w1:p1"), pane("w1:p2", { tab_id: "w1:t2" })];
    const fleet = (selected: string) => sidePanelModel(state(panes, [tab("w1:t2", "terminal")], {
      screen: "fleet", selection: { machineId: "local", paneId: selected, auto: false },
      runs: { status: "ready", data: runs, again: false }, fleetView: { ...INITIAL_STATE.fleetView, project: "/repo" },
    }));
    expect(fleet("w1:p2").terminals).toMatchObject({ shown: "w1:p2", inPane: true });
    expect(fleet("w1:p1").terminals).toMatchObject({ shown: "w1:p2", inPane: false });
  });

  it("shows a terminal it opened as opening until the session tree lists it", () => {
    const base = state([pane("w1:p1")], [], { selection: { machineId: "local", paneId: "w1:p1", auto: false } });
    const opened = { ...base, sidePanel: { ...base.sidePanel, terminals: { "w1:p1": { status: "opened" as const, paneId: "w1:p5" } } } };
    expect(sidePanelModel(opened).terminals).toMatchObject({ opening: true, shown: null });
    const listed = state([pane("w1:p1"), pane("w1:p5", { tab_id: "w1:t5" })], [tab("w1:t5", "terminal")], { selection: opened.selection, sidePanel: opened.sidePanel });
    expect(sidePanelModel(listed).terminals).toMatchObject({ opening: false, shown: "w1:p5" });
    const failed = { ...base, sidePanel: { ...base.sidePanel, terminals: { "w1:p1": { status: "failed" as const, message: "no herdr" } } } };
    expect(sidePanelModel(failed).terminals).toMatchObject({ opening: false, failed: "no herdr" });
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

describe("a side chat's turns", () => {
  const chat = (fields: Partial<SideChatSnapshot>): SideChatSnapshot => ({ id: "c1", paneId: "w1:p1", source: "fork", status: "working", turns: [], streaming: "", error: null, ...fields });
  const asked = { role: "user" as const, ts: null, parts: [{ kind: "text" as const, text: "why?" }] };

  it("show the reply's text as it comes after the last whole message", () => {
    const turns = [asked];
    expect(sideChatTurns(chat({ turns }))).toBe(turns);
    expect(sideChatTurns(chat({ turns, streaming: "Because" })).at(-1)).toEqual({ role: "assistant", ts: null, parts: [{ kind: "text", text: "Because" }] });
    const reading = { role: "assistant" as const, ts: null, parts: [{ kind: "tool" as const, name: "Read", summary: "a.ts", input: "", output: "" }] };
    expect(sideChatTurns(chat({ turns: [asked, reading], streaming: "So" })).at(-1)!.parts.map((part) => part.kind)).toEqual(["tool", "text"]);
  });
});
