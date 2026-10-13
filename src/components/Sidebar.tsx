import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Folder, GitBranch, GripVertical, Pencil, Plus, Terminal, X } from "lucide-react";

import "./Sidebar.css";

import type { AgentStatus, PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import type { Emit } from "../ui/bubble.ts";
import type { TreeEvent, TreeState } from "../ui/state.ts";
import { knownStatus, STATUS_WORD } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { menuPress, type PressPoint } from "../lib/longPress.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { folderName, placeLine, shortPathTitle } from "../lib/paneName.ts";
import { t } from "../lib/i18n.ts";
import { groupProjects } from "../lib/projectGroups.ts";

/** A fold belongs to a PC and a workspace (`workspace:<id>`) or a repository (`project:<repo_key>`). */
const collapsedKey = (machineId: string, groupKey: string) => {
  const [kind, ...rest] = groupKey.split(":");
  return `herdr-fleet:${kind}-collapsed:${machineId}:${rest.join(":")}`;
};
function storedCollapsed(machineId: string, groupKeys: string[]): Set<string> {
  const collapsed = new Set<string>();
  try {
    for (const id of groupKeys) if (localStorage.getItem(collapsedKey(machineId, id)) === "1") collapsed.add(id);
  } catch { /* storage denied: nothing is folded */ }
  return collapsed;
}
/** every fold a snapshot can show: its workspaces' and its projects' */
function foldKeys(snapshot: SessionSnapshot): string[] {
  return [...snapshot.workspaces.map((workspace) => `workspace:${workspace.workspace_id}`), ...groupProjects(snapshot.workspaces).filter((group) => group.repo !== null).map((group) => group.key)];
}

/** a workspace in a linked worktree (a fleet thread's, or one herdr made): its checkout on hover */
function WorktreeMark({ workspace }: { workspace: WorkspaceInfo }) {
  if (!workspace.worktree?.is_linked_worktree) return null;
  const title = t("Worktree {path}", { path: workspace.worktree.checkout_path });
  return <span className="worktree-mark" title={title}><GitBranch aria-hidden="true" /><span className="visually-hidden">{title}</span></span>;
}

/** shell prompt titles: `user@host:` is chrome, the path after it is the information */
const SHELL_PREFIX = /^[^:@\s]+@[^:@\s]+:/;
/** Herdr's agent glyph and spinner are already represented by the row mark and badge. */
const AGENT_CHROME = /^\u03c0\s*[^\p{L}\p{N}\s]?\s*/u;

function stripPaneChrome(title: string, agent: string | null | undefined): string {
  const shellStripped = title.replace(SHELL_PREFIX, "");
  return agent ? shellStripped.replace(AGENT_CHROME, "") : shellStripped;
}

export { paneTitle };

/**
 * The title a row or the header shows: the user's label, else the live title minus its chrome,
 * a working directory written out shortened to its last folder (lib/paneName.ts).
 */
export function displayPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent)) || pane.pane_id;
}

/** herdr could not bring this pane back after a restart (0.9.3+ `restore_error`): its reason, on hover. */
export function RestoreErrorBadge({ reason }: { reason: string }) {
  return <span className="badge badge-restore-error" title={reason}>{t("Not restored")}</span>;
}

/**
 * An agent's state word. A state herdr does not know has no badge at all, not a "—" one. In a
 * sidebar row (`dot`) only the dot shows: the word stays in its tooltip and for screen readers,
 * and the row's name gets the width.
 */
export function StatusBadge({ status, dot = false }: { status?: AgentStatus; dot?: boolean }) {
  const value = knownStatus(status);
  if (value === "unknown") return null;
  const word = t(STATUS_WORD[value]);
  return (
    <span className={`badge badge-${value}${dot ? " is-dot" : ""}`} data-status={value} title={t("Agent {status}", { status: word })}>
      {dot ? <span className="visually-hidden">{word}</span> : word}
    </span>
  );
}

function cwdBasename(cwd: string | null | undefined): string {
  return cwd ? folderName(cwd) : "unknown directory";
}

/** The row whose ⋯ menu is open: a pane's row, or the header of a workspace with several panes. */
type MenuState =
  | { kind: "pane"; anchor: HTMLElement; at: PressPoint | null; pane: PaneInfo; workspace: WorkspaceInfo; title: string; place: string }
  | { kind: "workspace"; anchor: HTMLElement; at: PressPoint | null; workspace: WorkspaceInfo };

/**
 * Closing a pane, as herdr's `ui.confirm_close` has it: the workspace's last pane takes the
 * workspace with it, so a confirm asks first; any other pane closes at once. The row menu and the
 * command palette both close a pane this way.
 */
export function closePaneEvent(machineId: string, paneId: string, title: string, paneCount: number): Extract<SidebarEvent, { type: "tree-ask" | "tree-close-pane" }> {
  return paneCount === 1
    ? { type: "tree-ask", machineId, action: { kind: "close-pane", paneId }, title: t("Close {title}?", { title }), body: t("Its workspace closes with it, and the agent and shell in it stop.") }
    : { type: "tree-close-pane", machineId, paneId };
}

/** The row's part the focus goes back to: what has it now, else its first control. */
function rowFocus(row: HTMLElement, own: string): HTMLElement {
  const active = document.activeElement;
  if (active instanceof HTMLElement && row.contains(active)) return active;
  return row.querySelector<HTMLElement>(own) ?? row;
}
/** What a PC's session tree draws. */
export interface SidebarModel {
  machineId: string;
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  /** the workspaces in the order drawn: a reorder herdr has not taken yet, else herdr's */
  workspaceOrder: string[];
  tree: TreeState;
}

/** What the tree sends up: its own changes, a pane picked, a new session (the shell's; in a project, at its root). */
export type SidebarEvent = TreeEvent | { type: "select-pane"; machineId: string; paneId: string } | { type: "new-session"; machineId: string; cwd?: string };

/** what a refused change says, beside its row */
export const FAILED: Record<NonNullable<TreeState["failure"]>["kind"], string> = {
  close: "Could not close. {reason}",
  rename: "Could not rename. {reason}",
  reorder: "Could not reorder. {reason}",
};

/**
 * A PC's sessions. The view keeps what only its look depends on: which row's menu is open, the
 * folds (stored per PC and group), the workspace being dragged.
 */
export function Sidebar({ model, emit }: { model: SidebarModel; emit: Emit<SidebarEvent> }) {
  const { machineId, snapshot, selectedPaneId, workspaceOrder, tree } = model;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const editingPaneId = tree.paneRename?.paneId ?? null;
  const paneLabel = tree.paneRename?.label ?? "";
  const editingWorkspaceId = tree.workspaceRename?.key ?? null;
  const workspaceLabel = tree.workspaceRename?.label ?? "";
  const inlineError = tree.failure === null ? null : { paneId: tree.failure.paneId, message: t(FAILED[tree.failure.kind], { reason: tree.failure.reason }) };
  const confirm = tree.confirm;
  const on = { machineId };
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => storedCollapsed(machineId, snapshot ? foldKeys(snapshot) : []));
  const unfoldedFor = useRef<string | null>(null);

  const setGroupCollapsed = (groupKey: string, collapsed: boolean): void => {
    setCollapsedGroups((current) => {
      if (current.has(groupKey) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(groupKey); else next.delete(groupKey);
      return next;
    });
    try {
      if (collapsed) localStorage.setItem(collapsedKey(machineId, groupKey), "1");
      else localStorage.removeItem(collapsedKey(machineId, groupKey));
    } catch {}
  };

  // a close confirmed and done took its row with it: the focus goes where a closed row's goes
  const confirmRunning = useRef(false);
  useEffect(() => {
    if (confirmRunning.current && confirm === null) focusWorkspaceListToggle();
    confirmRunning.current = confirm?.status === "running";
  }, [confirm]);

  useEffect(() => {
    if (!snapshot) return;
    // New workspaces and projects bring their stored fold state after reconnecting or creating a session.
    setCollapsedGroups((current) => {
      const stored = storedCollapsed(machineId, foldKeys(snapshot).filter((id) => !current.has(id)));
      return stored.size === 0 ? current : new Set([...current, ...stored]);
    });
  }, [snapshot, machineId]);

  // Reveal a newly selected pane once: its project and its workspace open. A fold made after
  // that, while the pane stays selected, stays.
  useEffect(() => {
    if (!selectedPaneId || !snapshot) return;
    const pane = snapshot.panes.find((pane) => pane.pane_id === selectedPaneId);
    if (!pane) return;
    const project = groupProjects(snapshot.workspaces).find((group) => group.workspaces.some((workspace) => workspace.workspace_id === pane.workspace_id));
    const opened = JSON.stringify([machineId, selectedPaneId]);
    if (unfoldedFor.current === opened) return;
    unfoldedFor.current = opened;
    setGroupCollapsed(`workspace:${pane.workspace_id}`, false);
    if (project && project.workspaces.length > 1) setGroupCollapsed(project.key, false);
  }, [selectedPaneId, snapshot, machineId]);

  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    return workspaceOrder.map((id) => byId.get(id)).filter((workspace): workspace is WorkspaceInfo => workspace !== undefined);
  }, [snapshot, workspaceOrder]);
  const projects = useMemo(() => groupProjects(orderedWorkspaces), [orderedWorkspaces]);
  const workspacePaneCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pane of snapshot?.panes ?? []) counts.set(pane.workspace_id, (counts.get(pane.workspace_id) ?? 0) + 1);
    return counts;
  }, [snapshot?.panes]);

  const closeMenu = useCallback(() => setMenu(null), []);
  // a row's menu opens from the row itself: right click, long press, or the menu key
  const press = useMemo(() => menuPress(), []);

  // A close that takes the workspace with it asks first, as herdr's ui.confirm_close does; a
  // pane that leaves its workspace standing closes at once, as herdr's tab menu does.

  const menuItems = (state: MenuState): RowMenuItem[] => {
    // the roster may have moved on since the menu opened (a sibling closed from another client):
    // what an item does follows the latest snapshot, not what the row showed at the click
    const workspace = snapshot?.workspaces.find((candidate) => candidate.workspace_id === state.workspace.workspace_id) ?? state.workspace;
    const paneCount = workspacePaneCounts.get(workspace.workspace_id) ?? 1;
    const renameWorkspaceItem: RowMenuItem = { id: "rename-workspace", label: t("Rename workspace"), icon: Pencil, run: () => beginWorkspaceRename(workspace) };
    if (state.kind === "workspace") {
      return [
        renameWorkspaceItem,
        { id: "close", label: t("Close workspace"), icon: X, divider: true, run: () => emit({ type: "tree-ask", ...on, action: { kind: "close-workspace", workspaceId: workspace.workspace_id }, title: t("Close workspace {name}?", { name: workspace.label }), body: t("{n} panes close with it, and the agents in them stop.", { n: paneCount }) }) },
      ];
    }
    const pane = snapshot?.panes.find((candidate) => candidate.pane_id === state.pane.pane_id) ?? state.pane;
    const renamePaneItem: RowMenuItem = { id: "rename-pane", label: t("Rename pane"), icon: Pencil, run: () => beginPaneRename(pane) };
    const closeItem: RowMenuItem = { id: "close", label: t("Close"), icon: X, divider: true, run: () => emit(closePaneEvent(machineId, pane.pane_id, state.title, paneCount)) };
    // a one-pane row has no header: it is the only place to rename its workspace
    return paneCount === 1 ? [renameWorkspaceItem, renamePaneItem, closeItem] : [renamePaneItem, closeItem];
  };

  // the roster moves under an open menu: a row that left takes its menu with it, and focus
  // goes where a closed row's focus goes
  useEffect(() => {
    if (!menu) return;
    const alive = menu.kind === "pane"
      ? snapshot?.panes.some((pane) => pane.pane_id === menu.pane.pane_id)
      : snapshot?.workspaces.some((workspace) => workspace.workspace_id === menu.workspace.workspace_id);
    if (alive && menu.anchor.isConnected) return;
    setMenu(null);
    focusWorkspaceListToggle();
  });

  const beginPaneRename = (pane: PaneInfo): void => emit({ type: "tree-start-pane-rename", ...on, paneId: pane.pane_id, label: pane.label ?? "" });

  const beginWorkspaceRename = (workspace: WorkspaceInfo): void =>
    emit({ type: "tree-start-workspace-rename", ...on, key: workspace.workspace_id, workspaceId: workspace.workspace_id, label: workspace.label });

  const reorderWorkspace = (workspaceId: string, insertIndex: number): void =>
    emit({ type: "tree-move-workspace", ...on, workspaceId, insertIndex, shown: workspaceOrder, herdr: snapshot?.workspaces.map((workspace) => workspace.workspace_id) ?? [] });

  const onDragStart = (event: DragEvent<HTMLElement>, workspaceId: string): void => {
    setDragWorkspaceId(workspaceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-herdr-workspace", JSON.stringify({ machine_id: machineId, workspace_id: workspaceId }));
  };

  const onDrop = (event: DragEvent<HTMLElement>, targetWorkspaceId: string): void => {
    event.preventDefault();
    let payload: { machine_id?: string; workspace_id?: string };
    try { payload = JSON.parse(event.dataTransfer.getData("application/x-herdr-workspace")); } catch { return; }
    if (payload.machine_id !== machineId || typeof payload.workspace_id !== "string") return;
    const sourceId = dragWorkspaceId ?? payload.workspace_id;
    setDragWorkspaceId(null);
    reorderWorkspace(sourceId, workspaceOrder.indexOf(targetWorkspaceId));
  };

  // Alt+arrow steps past the neighbour as drawn: a sibling inside a project, a whole project
  // outside one. A workspace in a project stays in it: its repository decides where it is drawn.
  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, workspaceId: string): void => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const up = event.key === "ArrowUp";
    const group = projects.find((candidate) => candidate.workspaces.some((workspace) => workspace.workspace_id === workspaceId));
    if (!group) return;
    let past: WorkspaceInfo | undefined;
    if (group.workspaces.length > 1) {
      past = group.workspaces[group.workspaces.findIndex((workspace) => workspace.workspace_id === workspaceId) + (up ? -1 : 1)];
    } else {
      const neighbour = projects[projects.indexOf(group) + (up ? -1 : 1)];
      past = neighbour && (up ? neighbour.workspaces[0] : neighbour.workspaces[neighbour.workspaces.length - 1]);
    }
    if (past) reorderWorkspace(workspaceId, workspaceOrder.indexOf(past.workspace_id));
  };

  const dragHandle = (workspace: WorkspaceInfo, draggable: boolean) => (
    <button
      type="button"
      className="sidebar-drag-handle"
      aria-label={t("Reorder workspace {name}", { name: workspace.label })}
      title={t("Drag to reorder · Alt+↑/↓")}
      draggable={draggable}
      onDragStart={(event) => onDragStart(event, workspace.workspace_id)}
      onDragEnd={() => setDragWorkspaceId(null)}
      onKeyDown={(event) => onHandleKeyDown(event, workspace.workspace_id)}
    >
      <GripVertical aria-hidden="true" />
    </button>
  );

  const renderWorkspace = (workspace: WorkspaceInfo) => {
    const visiblePanes = snapshot?.panes.filter((pane) => pane.workspace_id === workspace.workspace_id) ?? [];
    if (visiblePanes.length === 0) return null;
    // A single pane is its workspace: one row, no heading above it.
    const merged = visiblePanes.length === 1;
    const groupKey = `workspace:${workspace.workspace_id}`;
    // A merged row has no toggle: a fold stored while it had a heading (0.3.44) must not hide it.
    const collapsed = !merged && collapsedGroups.has(groupKey);
    const workspaceMenuOpen = menu?.kind === "workspace" && menu.workspace.workspace_id === workspace.workspace_id;
    return (
      <section
        className={`workspace${dragWorkspaceId === workspace.workspace_id ? " is-dragging" : ""}${collapsed ? " is-collapsed" : ""}`}
        key={workspace.workspace_id}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => onDrop(event, workspace.workspace_id)}
      >
        {!merged && (
          <header
            className={`workspace-header${workspaceMenuOpen ? " has-menu" : ""}`}
            {...press((at, row) => setMenu({ kind: "workspace", anchor: rowFocus(row, ".workspace-toggle, .sidebar-drag-handle"), at, workspace }))}
            draggable
            onDragStart={(event) => onDragStart(event, workspace.workspace_id)}
            onDragEnd={() => setDragWorkspaceId(null)}
          >
            {dragHandle(workspace, false)}
            <button type="button" className="workspace-toggle" aria-expanded={!collapsed} aria-label={collapsed ? t("Expand workspace {name}", { name: workspace.label }) : t("Collapse workspace {name}", { name: workspace.label })} title={collapsed ? t("Show panes") : t("Hide panes")} onClick={(event) => { event.stopPropagation(); setGroupCollapsed(groupKey, !collapsed); }}>
              {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>
            <span className="workspace-number">{workspace.number}</span>
            {editingWorkspaceId === workspace.workspace_id ? (
              <input
                className="input workspace-rename-input"
                aria-label={t("Workspace name")}
                autoFocus
                value={workspaceLabel}
                onChange={(event) => emit({ type: "tree-edit-workspace-rename", ...on, label: event.target.value })}
                onBlur={() => emit({ type: "tree-end-workspace-rename", ...on })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") emit({ type: "tree-save-workspace-rename", ...on });
                  if (event.key === "Escape") emit({ type: "tree-end-workspace-rename", ...on });
                }}
              />
            ) : (
              <span className="workspace-label" title={workspace.label} onDoubleClick={() => beginWorkspaceRename(workspace)}>
                {workspace.label}
              </span>
            )}
            <WorktreeMark workspace={workspace} />
            <StatusBadge status={workspace.agent_status} dot />
          </header>
        )}

        {!collapsed && <ul className="pane-list">
          {visiblePanes.map((pane) => {
            const fullTitle = paneTitle(pane);
            const displayTitle = displayPaneTitle(pane);
            // A workspace's rows name the folder. A workspace is usually named after its folder, and a
            // shell titled by it: the folder shows only when neither already says it. A merged row has
            // no workspace header, so it names the workspace too, unless the title already is that name.
            const folder = cwdBasename(pane.cwd);
            const said = folder === displayTitle || folder === workspace.label;
            const place = merged ? placeLine(workspace.label === displayTitle ? "" : workspace.label, said ? "" : folder)
              : said ? "" : folder;
            const selected = pane.pane_id === selectedPaneId;
            const editing = editingPaneId === pane.pane_id;
            const paneMenuOpen = menu?.kind === "pane" && menu.pane.pane_id === pane.pane_id;
            return (
              <li className={`pane-item${selected ? " is-selected" : ""}`} key={pane.pane_id}>
                <div
                  className={`pane-row${paneMenuOpen ? " has-menu" : ""}`}
                  {...press((at, row) => setMenu({ kind: "pane", anchor: rowFocus(row, ".pane-select"), at, pane, workspace, title: displayTitle, place: place || workspace.label }))}
                >
                  {merged && dragHandle(workspace, true)}
                  <div
                    className="pane-select"
                    role="button"
                    tabIndex={0}
                    aria-current={selected ? "true" : undefined}
                    title={`${pane.pane_id} — ${fullTitle}${pane.cwd ? ` — ${pane.cwd}` : ""}`}
                    onClick={() => emit({ type: "select-pane", ...on, paneId: pane.pane_id })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      emit({ type: "select-pane", ...on, paneId: pane.pane_id });
                    }}
                  >
                    <span className={`agent-mark-holder${pane.agent ? "" : " is-shell"}`} title={pane.agent ?? t("Shell")}>
                      {pane.agent ? <AgentMark agent={pane.agent} size={18} /> : <Terminal aria-hidden="true" />}
                    </span>
                    <span className="pane-copy">
                      <span className="pane-primary">
                        {editing ? (
                          <input
                            className="input pane-rename-input"
                            aria-label={t("Pane name")}
                            autoFocus
                            value={paneLabel}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => emit({ type: "tree-edit-pane-rename", ...on, label: event.target.value })}
                            onBlur={() => emit({ type: "tree-end-pane-rename", ...on })}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") emit({ type: "tree-save-pane-rename", ...on });
                              if (event.key === "Escape") emit({ type: "tree-end-pane-rename", ...on });
                            }}
                          />
                        ) : (
                          <span className="pane-title">{displayTitle}</span>
                        )}
                      </span>
                      {merged && editingWorkspaceId === workspace.workspace_id ? (
                        <input
                          className="input pane-rename-input workspace-rename-input"
                          aria-label={t("Workspace name")}
                          autoFocus
                          value={workspaceLabel}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => emit({ type: "tree-edit-workspace-rename", ...on, label: event.target.value })}
                          onBlur={() => emit({ type: "tree-end-workspace-rename", ...on })}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") emit({ type: "tree-save-workspace-rename", ...on });
                            if (event.key === "Escape") emit({ type: "tree-end-workspace-rename", ...on });
                          }}
                        />
                      ) : (
                        (place || (merged && workspace.worktree?.is_linked_worktree)) && <span className="pane-subtitle">{merged && <WorktreeMark workspace={workspace} />}{place}</span>
                      )}
                    </span>
                    {/* a pane with no agent has no state to tell: no badge, not a "—" one */}
                    {pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : pane.agent && <StatusBadge status={pane.agent_status} dot />}
                  </div>
                </div>
                {inlineError?.paneId === pane.pane_id && <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>}
              </li>
            );
          })}
        </ul>}
      </section>
    );
  };

  return (
    <div className="machine-workspaces">
      <nav className="sidebar-list" aria-label={t("Herdr workspaces")}>
        {!snapshot && <p className="tree-state" role="status">{t("Loading workspaces…")}</p>}
        {snapshot && snapshot.workspaces.length === 0 && (
          <div className="tree-state-empty">
            <p className="tree-state" role="status">{t("No workspaces yet")}</p>
            <button type="button" className="btn" onClick={() => emit({ type: "new-session", ...on })}><Plus aria-hidden="true" />{t("New session")}</button>
          </div>
        )}
        {projects.map((project) => {
          // a project with one workspace draws just that workspace: a heading names a group of two or more
          if (project.repo === null || project.workspaces.length === 1) return project.workspaces.map(renderWorkspace);
          const { name, root } = project.repo;
          const collapsed = collapsedGroups.has(project.key);
          return <section className={`project-group${collapsed ? " is-collapsed" : ""}`} key={project.key} data-project={root}>
            <div className="project-header">
              <button type="button" className="project-toggle" aria-expanded={!collapsed} aria-label={collapsed ? t("Expand project {name}", { name }) : t("Collapse project {name}", { name })} title={root} onClick={() => setGroupCollapsed(project.key, !collapsed)}>
                {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                <Folder aria-hidden="true" />
                <span className="project-copy"><span className="project-name">{name}</span><span className="project-path">{root}</span></span>
                <span className="workspace-number" title={t("{n} workspaces", { n: project.workspaces.length })}>{project.workspaces.length}</span>
              </button>
              <button type="button" className="icon-button project-add" aria-label={t("New session in {name}", { name })} title={t("New session")} onClick={() => emit({ type: "new-session", ...on, cwd: root })}>
                <Plus aria-hidden="true" />
              </button>
            </div>
            {!collapsed && <div className="project-contents">{project.workspaces.map(renderWorkspace)}</div>}
          </section>;
        })}
        {inlineError && inlineError.paneId === undefined && (
          <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>
        )}
      </nav>
      {menu && <RowMenu anchor={menu.anchor} at={menu.at} title={menu.kind === "pane" ? menu.title : menu.workspace.label} subtitle={menu.kind === "pane" ? menu.place : undefined} items={menuItems(menu)} onClose={closeMenu} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={t("Close")} pending={confirm.status === "running"} error={confirm.error ?? null} onConfirm={() => emit({ type: "tree-confirm", ...on })} onClose={() => emit({ type: "tree-cancel", ...on })} />}
    </div>
  );
}
