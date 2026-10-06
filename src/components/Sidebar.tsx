import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Ellipsis, Folder, GripVertical, Layers, Pencil, Plus, Terminal, X } from "lucide-react";

import "./Sidebar.css";

import type { AgentStatus, PaneInfo, SessionSnapshot, WorkspaceInfo, HerdrPane } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import type { Emit } from "../ui/bubble.ts";
import type { TreeEvent, TreeState } from "../ui/state.ts";
import { knownStatus, STATUS_WORD } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { folderName, placeLine, shortPathTitle } from "../lib/paneName.ts";
import { useT } from "../lib/i18n.ts";
import { groupDirectories } from "../lib/directoryGroups.ts";
import type { SidebarGrouping } from "../lib/settings.ts";

/** Folder folds belong to a PC and full path, not an individual workspace. */
const collapsedKey = (machineId: string, groupKey: string) => {
  const workspace = groupKey.startsWith("workspace:");
  return `herdr-fleet:${workspace ? "workspace" : "directory"}-collapsed:${machineId}:${groupKey.slice(workspace ? "workspace:".length : "folder:".length)}`;
};
function storedCollapsed(machineId: string, directoryKeys: string[]): Set<string> {
  const collapsed = new Set<string>();
  try {
    for (const id of directoryKeys) if (localStorage.getItem(collapsedKey(machineId, id)) === "1") collapsed.add(id);
  } catch { /* storage denied: nothing is folded */ }
  return collapsed;
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
  const t = useT();
  return <span className="badge badge-restore-error" title={reason}>{t("NOT RESTORED")}</span>;
}

export function StatusBadge({ status }: { status?: AgentStatus }) {
  const t = useT();
  const value = knownStatus(status);
  return (
    <span className={`badge badge-${value}`} data-status={value} title={t("Agent {status}", { status: t(STATUS_WORD[value]) })}>
      {t(STATUS_WORD[value])}
    </span>
  );
}

/**
 * Background tasks an agent started that still run (OmO's `task` children): the main turn can be
 * done while they work, and they wake the session by themselves. A count beside the state word,
 * not a state of its own: DONE stays the moment the agent answered.
 */
export function BackgroundBadge({ count }: { count?: number }) {
  const t = useT();
  if (!count || count <= 0) return null;
  const label = t("Background tasks running: {count}", { count });
  return (
    <span className="badge badge-background" title={label} aria-label={label} data-testid="background-tasks">
      <Layers aria-hidden="true" />{count}
    </span>
  );
}

function cwdBasename(cwd: string | null | undefined): string {
  return cwd ? folderName(cwd) : "unknown directory";
}

/** The row whose ⋯ menu is open: a pane's row, or the header of a workspace with several panes. */
type MenuState =
  | { kind: "pane"; anchor: HTMLElement; pane: PaneInfo; workspace: WorkspaceInfo; scope: string; title: string; place: string }
  | { kind: "workspace"; anchor: HTMLElement; workspace: WorkspaceInfo; scope: string };
/** What a PC's session tree draws. */
export interface SidebarModel {
  machineId: string;
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  grouping: SidebarGrouping;
  /** the workspaces in the order drawn: a reorder herdr has not taken yet, else herdr's */
  workspaceOrder: string[];
  tree: TreeState;
}

/** What the tree sends up: its own changes, a pane picked, a new session (the shell's). */
export type SidebarEvent = TreeEvent | { type: "select-pane"; machineId: string; paneId: string } | { type: "new-session"; machineId: string };

/** what a refused change says, beside its row */
export const FAILED: Record<NonNullable<TreeState["failure"]>["kind"], string> = {
  close: "Close failed: {reason}",
  rename: "Rename failed: {reason}",
  reorder: "Reorder failed: {reason}",
};

/**
 * A PC's sessions. The view keeps what only its look depends on: which row's menu is open, the
 * folds (stored per PC and group), the workspace being dragged.
 */
export function Sidebar({ model, emit }: { model: SidebarModel; emit: Emit<SidebarEvent> }) {
  const t = useT();
  const { machineId, snapshot, selectedPaneId, workspaceOrder, tree } = model;
  const byFolder = model.grouping === "directory";
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const editingPaneId = tree.paneRename?.paneId ?? null;
  const paneLabel = tree.paneRename?.label ?? "";
  const editingWorkspaceId = tree.workspaceRename?.key ?? null;
  const workspaceLabel = tree.workspaceRename?.label ?? "";
  const inlineError = tree.failure === null ? null : { paneId: tree.failure.paneId, message: t(FAILED[tree.failure.kind], { reason: tree.failure.reason }) };
  const confirm = tree.confirm;
  const on = { machineId };
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => storedCollapsed(machineId, snapshot ? [...snapshot.workspaces.map((workspace) => `workspace:${workspace.workspace_id}`), ...groupDirectories(snapshot.workspaces, snapshot.panes).map((group) => `folder:${group.key}`)] : []));
  const unfoldedFor = useRef<Partial<Record<SidebarGrouping, string>>>({});

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
    const serverOrder = snapshot.workspaces.map((workspace) => workspace.workspace_id);
    // New folders bring their stored fold state after reconnecting or creating a session.
    setCollapsedGroups((current) => {
      const keys = [...serverOrder.map((id) => `workspace:${id}`), ...groupDirectories(snapshot.workspaces, snapshot.panes).map((group) => `folder:${group.key}`)];
      const stored = storedCollapsed(machineId, keys.filter((id) => !current.has(id)));
      return stored.size === 0 ? current : new Set([...current, ...stored]);
    });
  }, [snapshot, machineId]);

  // Reveal a newly selected pane once per mode; toggling back preserves its deliberate fold.
  useEffect(() => {
    if (!selectedPaneId || !snapshot) return;
    const pane = snapshot.panes.find((pane) => pane.pane_id === selectedPaneId);
    if (!pane) return;
    const directory = byFolder ? groupDirectories(snapshot.workspaces, snapshot.panes).find((group) => group.workspaces.some((entry) => entry.panes.some((pane) => pane.pane_id === selectedPaneId))) : null;
    if (byFolder && !directory) return;
    const groupKey = directory ? `folder:${directory.key}` : `workspace:${pane.workspace_id}`;
    const opened = JSON.stringify([machineId, selectedPaneId, groupKey]);
    if (unfoldedFor.current[model.grouping] === opened) return;
    unfoldedFor.current[model.grouping] = opened;
    setGroupCollapsed(groupKey, false);
  }, [selectedPaneId, snapshot, machineId, model.grouping, byFolder]);

  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    return workspaceOrder.map((id) => byId.get(id)).filter((workspace): workspace is WorkspaceInfo => workspace !== undefined);
  }, [snapshot, workspaceOrder]);
  const directories = useMemo(() => groupDirectories(orderedWorkspaces, snapshot?.panes ?? []), [orderedWorkspaces, snapshot?.panes]);
  const workspacePaneCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pane of snapshot?.panes ?? []) counts.set(pane.workspace_id, (counts.get(pane.workspace_id) ?? 0) + 1);
    return counts;
  }, [snapshot?.panes]);

  const closeMenu = useCallback(() => setMenu(null), []);

  // A close that takes the workspace with it asks first, as herdr's ui.confirm_close does; a
  // pane that leaves its workspace standing closes at once, as herdr's tab menu does.

  const menuItems = (state: MenuState): RowMenuItem[] => {
    // the roster may have moved on since the menu opened (a sibling closed from another client):
    // what an item does follows the latest snapshot, not what the row showed at the click
    const workspace = snapshot?.workspaces.find((candidate) => candidate.workspace_id === state.workspace.workspace_id) ?? state.workspace;
    const paneCount = workspacePaneCounts.get(workspace.workspace_id) ?? 1;
    const renameWorkspaceItem: RowMenuItem = { id: "rename-workspace", label: t("Rename workspace"), icon: Pencil, run: () => beginWorkspaceRename(workspace, state.scope) };
    if (state.kind === "workspace") {
      return [
        renameWorkspaceItem,
        { id: "close", label: t("Close workspace"), icon: X, danger: true, divider: true, run: () => emit({ type: "tree-ask", ...on, action: { kind: "close-workspace", workspaceId: workspace.workspace_id }, title: t("Close workspace {name}?", { name: workspace.label }), body: t("{n} panes close with it, and the agents in them stop.", { n: paneCount }) }) },
      ];
    }
    const pane = snapshot?.panes.find((candidate) => candidate.pane_id === state.pane.pane_id) ?? state.pane;
    const renamePaneItem: RowMenuItem = { id: "rename-pane", label: t("Rename pane"), icon: Pencil, run: () => beginPaneRename(pane) };
    // the workspace's last pane takes the workspace with it
    const closeItem: RowMenuItem = paneCount === 1
      ? { id: "close", label: t("Close"), icon: X, danger: true, divider: true, run: () => emit({ type: "tree-ask", ...on, action: { kind: "close-pane", paneId: pane.pane_id }, title: t("Close {title}?", { title: state.title }), body: t("Its workspace closes with it, and the agent and shell in it stop.") }) }
      : { id: "close", label: t("Close"), icon: X, danger: true, divider: true, run: () => emit({ type: "tree-close-pane", ...on, paneId: pane.pane_id }) };
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

  // By folder, one workspace can show under several folders: only the copy that was clicked edits.
  // Two mounted inputs would take the focus from each other, and the blur closes both.
  const beginWorkspaceRename = (workspace: WorkspaceInfo, scope: string): void =>
    emit({ type: "tree-start-workspace-rename", ...on, key: `${scope}\u0000${workspace.workspace_id}`, workspaceId: workspace.workspace_id, label: workspace.label });

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

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, workspaceId: string): void => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const current = workspaceOrder.indexOf(workspaceId);
    reorderWorkspace(workspaceId, current + (event.key === "ArrowUp" ? -1 : 1));
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

  const renderWorkspace = (workspace: WorkspaceInfo, visiblePanes: PaneInfo[], scope = "") => {
    if (visiblePanes.length === 0) return null;
    // A single pane is its workspace: one row, no heading above it. Count the whole
    // workspace: a folder can show one pane of a workspace that has more, and that
    // heading is the only place to rename the workspace.
    const merged = (workspacePaneCounts.get(workspace.workspace_id) ?? visiblePanes.length) === 1;
    const groupKey = `workspace:${workspace.workspace_id}`;
    // A merged row has no toggle: a fold stored while it had a heading (0.3.44) must not hide it.
    const collapsed = !byFolder && !merged && collapsedGroups.has(groupKey);
    const workspaceMenuOpen = menu?.kind === "workspace" && menu.workspace.workspace_id === workspace.workspace_id && menu.scope === scope;
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
            className="workspace-header"
            draggable
            onDragStart={(event) => onDragStart(event, workspace.workspace_id)}
            onDragEnd={() => setDragWorkspaceId(null)}
          >
            {dragHandle(workspace, false)}
            {!byFolder && <button type="button" className="workspace-toggle" aria-expanded={!collapsed} aria-label={collapsed ? t("Expand workspace {name}", { name: workspace.label }) : t("Collapse workspace {name}", { name: workspace.label })} title={collapsed ? t("Show panes") : t("Hide panes")} onClick={(event) => { event.stopPropagation(); setGroupCollapsed(groupKey, !collapsed); }}>
              {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>}
            <span className="workspace-number">{workspace.number}</span>
            {editingWorkspaceId === `${scope}\u0000${workspace.workspace_id}` ? (
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
              <span className="workspace-label" title={workspace.label} onDoubleClick={() => beginWorkspaceRename(workspace, scope)}>
                {workspace.label}
              </span>
            )}
            <StatusBadge status={workspace.agent_status} />
            <button type="button" className="sidebar-row-action row-menu-toggle workspace-menu" aria-label={t("More for workspace {name}", { name: workspace.label })} aria-haspopup="menu" aria-expanded={workspaceMenuOpen} onClick={(event) => workspaceMenuOpen ? setMenu(null) : setMenu({ kind: "workspace", anchor: event.currentTarget, workspace, scope })}>
              <Ellipsis aria-hidden="true" />
            </button>
          </header>
        )}

        {!collapsed && <ul className="pane-list">
          {visiblePanes.map((pane) => {
            const fullTitle = paneTitle(pane);
            const displayTitle = displayPaneTitle(pane);
            // The group header already names one of the two: a workspace's rows name the folder, a
            // folder's rows the workspace. A workspace is usually named after its folder, and a shell
            // titled by it: the folder shows only when neither already says it. A merged row has no
            // workspace header, so it names the workspace too, unless the title already is that name.
            const folder = cwdBasename(pane.cwd);
            const said = folder === displayTitle || folder === workspace.label;
            const place = byFolder ? workspace.label
              : merged ? placeLine(workspace.label === displayTitle ? "" : workspace.label, said ? "" : folder)
              : said ? "" : folder;
            const selected = pane.pane_id === selectedPaneId;
            const editing = editingPaneId === pane.pane_id;
            const paneMenuOpen = menu?.kind === "pane" && menu.pane.pane_id === pane.pane_id;
            return (
              <li className={`pane-item${selected ? " is-selected" : ""}`} key={pane.pane_id}>
                <div className="pane-row">
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
                      {pane.agent ? <AgentMark agent={pane.agent} size={22} /> : <Terminal aria-hidden="true" />}
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
                      {merged && editingWorkspaceId === `${scope}\u0000${workspace.workspace_id}` ? (
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
                        <span className="pane-meta">
                          {pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : <StatusBadge status={pane.agent_status} />}
                          <BackgroundBadge count={(pane as HerdrPane).background_tasks} />
                          {place && <span className="pane-subtitle">{place}</span>}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="pane-actions">
                    <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title: displayTitle })} aria-haspopup="menu" aria-expanded={paneMenuOpen} onClick={(event) => paneMenuOpen ? setMenu(null) : setMenu({ kind: "pane", anchor: event.currentTarget, pane, workspace, scope, title: displayTitle, place: place || workspace.label })}>
                      <Ellipsis aria-hidden="true" />
                    </button>
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
        {byFolder ? directories.map((directory) => {
          const collapsed = collapsedGroups.has(`folder:${directory.key}`);
          const name = directory.path ? cwdBasename(directory.path) : directory.workspaces[0]?.workspace.label;
          return <section className={`directory-group${collapsed ? " is-collapsed" : ""}`} key={directory.key} data-directory={directory.path ?? directory.key}>
            <button type="button" className="directory-header" aria-expanded={!collapsed} aria-label={collapsed ? t("Expand folder {name}", { name: directory.path ?? name ?? "" }) : t("Collapse folder {name}", { name: directory.path ?? name ?? "" })} title={directory.path ?? name} onClick={() => setGroupCollapsed(`folder:${directory.key}`, !collapsed)}>
              {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              <Folder aria-hidden="true" />
              <span className="directory-copy"><span className="directory-name">{name}</span>{directory.path && <span className="directory-path">{directory.path}</span>}</span>
              <span className="workspace-number">{directory.paneCount}</span>
            </button>
            {!collapsed && <div className="directory-contents">{directory.workspaces.map(({ workspace, panes: visiblePanes }) => {
              return renderWorkspace(workspace, visiblePanes, directory.key);
        })}</div>}
          </section>;
        }) : orderedWorkspaces.map((workspace) => renderWorkspace(workspace, snapshot?.panes.filter((pane) => pane.workspace_id === workspace.workspace_id) ?? []))}
        {inlineError && inlineError.paneId === undefined && (
          <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>
        )}
      </nav>
      {menu && <RowMenu anchor={menu.anchor} title={menu.kind === "pane" ? menu.title : menu.workspace.label} subtitle={menu.kind === "pane" ? menu.place : undefined} items={menuItems(menu)} onClose={closeMenu} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={t("Close")} pending={confirm.status === "running"} error={confirm.error ?? null} onConfirm={() => emit({ type: "tree-confirm", ...on })} onClose={() => emit({ type: "tree-cancel", ...on })} />}
    </div>
  );
}
