import { describe, expect, it } from "bun:test";
import type { WorkspaceInfo } from "../../shared/protocol.ts";
import { groupProjects, projectAt } from "./projectGroups.ts";

const workspace = (id: string, repo?: string, checkout = repo): WorkspaceInfo => ({
  workspace_id: id, label: id, number: 1, active_tab_id: `${id}:t1`, agent_status: "idle", focused: false, pane_count: 1, tab_count: 1,
  ...(repo ? { worktree: { repo_key: `${repo}/.git`, repo_name: repo.split("/").pop()!, repo_root: repo, checkout_path: checkout!, is_linked_worktree: checkout !== repo } } : {}),
});

describe("groupProjects", () => {
  it("puts the workspaces of one repository together, its linked worktrees too", () => {
    const groups = groupProjects([workspace("w1", "/git/app"), workspace("w2", "/git/app", "/git/app/.herdr-fleet/worktrees/a"), workspace("w3", "/git/app")]);
    expect(groups).toEqual([{ key: "project:/git/app/.git", repo: { name: "app", root: "/git/app" }, workspaces: groups[0]!.workspaces }]);
    expect(groups[0]!.workspaces.map((each) => each.workspace_id)).toEqual(["w1", "w2", "w3"]);
  });

  it("keeps a workspace outside Git on its own, and repositories with the same name apart", () => {
    const groups = groupProjects([workspace("w1"), workspace("w2"), workspace("w3", "/a/app"), workspace("w4", "/b/app")]);
    expect(groups.map((group) => [group.key, group.workspaces.length])).toEqual([["workspace:w1", 1], ["workspace:w2", 1], ["project:/a/app/.git", 1], ["project:/b/app/.git", 1]]);
  });

  it("places a project where its first workspace is drawn and keeps the drawn order inside", () => {
    const workspaces = [workspace("w1", "/a"), workspace("w2", "/b"), workspace("w3", "/a")];
    const before = structuredClone(workspaces);
    expect(groupProjects(workspaces).map((group) => group.workspaces.map((each) => each.workspace_id))).toEqual([["w1", "w3"], ["w2"]]);
    expect(workspaces).toEqual(before);
  });
});

describe("projectAt", () => {
  const workspaces = [workspace("w1", "/git/app"), workspace("w2", "/git/application")];
  it("finds the repository a typed folder lies in, by whole path segments", () => {
    expect(projectAt(workspaces, "/git/app")?.key).toBe("project:/git/app/.git");
    expect(projectAt(workspaces, "/git/app/src/")?.key).toBe("project:/git/app/.git");
    expect(projectAt(workspaces, "/git/application")?.key).toBe("project:/git/application/.git");
    expect(projectAt(workspaces, "/git/ap")).toBeNull();
    expect(projectAt(workspaces, "  ")).toBeNull();
  });
});
