import { describe, expect, it } from "bun:test";
import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../shared/protocol.ts";
import { HerdrError } from "./herdr/client.ts";
import { WorkspaceProjects, type WorktreeList } from "./projects.ts";

const workspace = (id: string, worktree?: WorkspaceInfo["worktree"]): WorkspaceInfo => ({ workspace_id: id, label: id, number: 1, active_tab_id: `${id}:t1`, agent_status: "idle", focused: false, pane_count: 1, tab_count: 1, ...(worktree ? { worktree } : {}) });
const pane = (id: string, workspaceId: string, cwd: string): PaneInfo => ({ pane_id: id, workspace_id: workspaceId, cwd, tab_id: `${workspaceId}:t1`, terminal_id: id, revision: 1, focused: false, agent_status: "idle" });
const snapshot = (workspaces: WorkspaceInfo[], panes: PaneInfo[]): SessionSnapshot => ({ workspaces, panes, tabs: [], agents: [], layouts: [], protocol: 22, version: "0.9.3" }) as SessionSnapshot;
const repo = (root: string, linked?: { path: string; workspaceId: string }): WorktreeList => ({
  source: { repo_key: `${root}/.git`, repo_name: root.split("/").pop()!, repo_root: root, source_checkout_path: root },
  worktrees: [{ path: root, is_linked_worktree: false }, ...(linked ? [{ path: linked.path, is_linked_worktree: true, open_workspace_id: linked.workspaceId }] : [])],
});
const notGit = () => new HerdrError("not_git_worktree", "Herdr worktree actions require a workspace inside a Git work tree");

describe("WorkspaceProjects", () => {
  it("fills the repository herdr names for a workspace without one, and keeps herdr's own", async () => {
    const own = { repo_key: "/r/.git", repo_name: "r", repo_root: "/r", checkout_path: "/r/.herdr-fleet/worktrees/a", is_linked_worktree: true };
    const asked: string[] = [];
    const projects = new WorkspaceProjects(async (id) => { asked.push(id); return repo("/r"); });
    const shown = await projects.attach(snapshot([workspace("w1"), workspace("w2", own)], [pane("p1", "w1", "/r/src"), pane("p2", "w2", own.checkout_path)]));
    expect(shown.workspaces.map((each) => each.worktree)).toEqual([{ repo_key: "/r/.git", repo_name: "r", repo_root: "/r", checkout_path: "/r", is_linked_worktree: false }, own]);
    expect(asked).toEqual(["w1"]);
  });

  it("marks a linked worktree herdr lists as open in that workspace", async () => {
    const projects = new WorkspaceProjects(async () => repo("/r", { path: "/w/feature", workspaceId: "w1" }));
    const [shown] = (await projects.attach(snapshot([workspace("w1")], [pane("p1", "w1", "/w/feature")]))).workspaces;
    expect(shown?.worktree).toMatchObject({ repo_key: "/r/.git", checkout_path: "/w/feature", is_linked_worktree: true });
  });

  it("keeps a workspace's repository after a cd, and asks again outside Git only when the folders change", async () => {
    const answers: Record<string, () => WorktreeList> = { w1: () => repo("/r"), w2: () => { throw notGit(); } };
    let asked = 0;
    const projects = new WorkspaceProjects(async (id) => { asked++; return answers[id]!(); });
    await projects.attach(snapshot([workspace("w1"), workspace("w2")], [pane("p1", "w1", "/r"), pane("p2", "w2", "/home")]));
    expect(asked).toBe(2);
    answers["w1"] = () => repo("/elsewhere");
    const moved = await projects.attach(snapshot([workspace("w1"), workspace("w2")], [pane("p1", "w1", "/elsewhere"), pane("p2", "w2", "/home")]));
    expect(asked).toBe(2);
    expect(moved.workspaces.map((each) => each.worktree?.repo_root ?? null)).toEqual(["/r", null]);
    answers["w2"] = () => repo("/s");
    const joined = await projects.attach(snapshot([workspace("w1"), workspace("w2")], [pane("p1", "w1", "/elsewhere"), pane("p2", "w2", "/s")]));
    expect(asked).toBe(3);
    expect(joined.workspaces.map((each) => each.worktree?.repo_root ?? null)).toEqual(["/r", "/s"]);
  });

  it("asks again after a failure that is not an answer, and forgets closed workspaces", async () => {
    let fail = true;
    let asked = 0;
    const projects = new WorkspaceProjects(async () => { asked++; if (fail) throw new HerdrError("timeout", "slow"); return repo("/r"); });
    const first = await projects.attach(snapshot([workspace("w1")], [pane("p1", "w1", "/r")]));
    expect(first.workspaces[0]?.worktree).toBeUndefined();
    fail = false;
    expect((await projects.attach(snapshot([workspace("w1")], [pane("p1", "w1", "/r")]))).workspaces[0]?.worktree?.repo_root).toBe("/r");
    await projects.attach(snapshot([], []));
    await projects.attach(snapshot([workspace("w1")], [pane("p1", "w1", "/r")]));
    expect(asked).toBe(3);
  });
});
