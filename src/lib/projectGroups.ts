import type { WorkspaceInfo } from "../../shared/protocol.ts";

/** The workspaces of one Git repository, or a workspace outside Git on its own. */
export interface ProjectGroup {
  /** `project:<repo_key>`, or `workspace:<id>` outside Git */
  key: string;
  /** the repository: its name and main checkout, as herdr gives them */
  repo: { name: string; root: string } | null;
  workspaces: WorkspaceInfo[];
}

/**
 * Workspaces by repository (herdr's `repo_key`: a linked worktree joins its main checkout's),
 * placed where the first of each is drawn and keeping that order inside. A workspace outside Git
 * is a group of its own; the sidebar draws a heading only above a group of two or more.
 */
export function groupProjects(workspaces: WorkspaceInfo[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const workspace of workspaces) {
    const worktree = workspace.worktree;
    const key = worktree ? `project:${worktree.repo_key}` : `workspace:${workspace.workspace_id}`;
    const group = groups.get(key) ?? { key, repo: worktree ? { name: worktree.repo_name, root: worktree.repo_root } : null, workspaces: [] };
    group.workspaces.push(workspace);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The repository a folder lies in, among those the workspaces already work in: by path, as typed. */
export function projectAt(workspaces: WorkspaceInfo[], cwd: string): ProjectGroup | null {
  const folder = cwd.trim().replace(/\/+$/, "");
  if (!folder) return null;
  return groupProjects(workspaces).find((group) => group.repo !== null && (folder === group.repo.root || folder.startsWith(`${group.repo.root}/`))) ?? null;
}
