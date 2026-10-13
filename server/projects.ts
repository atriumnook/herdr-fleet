import type { SessionSnapshot } from "../shared/protocol.ts";
import type { WorkspaceWorktreeInfo } from "../shared/herdr-api.generated.ts";
import { HerdrError, herdrRpc } from "./herdr/client.ts";

/** What `worktree.list` answers for a workspace: its repository, and the checkouts herdr knows in it. */
export interface WorktreeList {
  source: { repo_key: string; repo_name: string; repo_root: string; source_checkout_path: string };
  worktrees: Array<{ path: string; is_linked_worktree: boolean; open_workspace_id?: string | null }>;
}

/** short: a new workspace's first snapshot waits for this answer */
export const listWorktrees = (workspaceId: string, socketPath?: string): Promise<WorktreeList> =>
  herdrRpc<WorktreeList>("worktree.list", { workspace_id: workspaceId }, socketPath, 3000);

/**
 * The repository each workspace works in, for the sidebar's projects. herdr fills a workspace's
 * `worktree` only once a worktree action touched it; for the rest this asks herdr's own
 * `worktree.list` (herdr runs git, this server does not). herdr answers from the pane's current
 * folder, so a workspace keeps the repository it was first found in: a `cd` does not move it to
 * another project. A workspace outside any repository is asked again when its folders change.
 */
export class WorkspaceProjects {
  private known = new Map<string, { worktree: WorkspaceWorktreeInfo | null; folders: string }>();

  constructor(private list: (workspaceId: string) => Promise<WorktreeList> = (workspaceId) => listWorktrees(workspaceId)) {}

  async attach(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
    const live = new Set(snapshot.workspaces.map((workspace) => workspace.workspace_id));
    for (const id of this.known.keys()) if (!live.has(id)) this.known.delete(id);
    const folders = (workspaceId: string) => snapshot.panes.filter((pane) => pane.workspace_id === workspaceId).map((pane) => pane.cwd ?? "").join("\u0000");
    await Promise.all(snapshot.workspaces.map(async (workspace) => {
      if (workspace.worktree) return;
      const id = workspace.workspace_id;
      const seen = this.known.get(id);
      if (seen && (seen.worktree !== null || seen.folders === folders(id))) return;
      try {
        this.known.set(id, { worktree: worktreeOf(id, await this.list(id)), folders: folders(id) });
      } catch (error) {
        // a workspace outside Git is an answer; a timeout or a lost socket is asked again next read
        if (error instanceof HerdrError && error.code === "not_git_worktree") this.known.set(id, { worktree: null, folders: folders(id) });
      }
    }));
    return {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => {
        const worktree = workspace.worktree ?? this.known.get(workspace.workspace_id)?.worktree;
        return worktree ? { ...workspace, worktree } : workspace;
      }),
    };
  }
}

function worktreeOf(workspaceId: string, list: WorktreeList): WorkspaceWorktreeInfo {
  const own = list.worktrees.find((worktree) => worktree.open_workspace_id === workspaceId);
  return {
    repo_key: list.source.repo_key,
    repo_name: list.source.repo_name,
    repo_root: list.source.repo_root,
    checkout_path: own?.path ?? list.source.source_checkout_path,
    is_linked_worktree: own?.is_linked_worktree ?? false,
  };
}
