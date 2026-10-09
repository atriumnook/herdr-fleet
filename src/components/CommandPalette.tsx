import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Bell, FolderOpen, LockKeyhole, MessageSquarePlus, PanelLeft, RefreshCw, Settings, SunMoon, SwitchCamera, X } from "lucide-react";

import "./CommandPalette.css";

import type { PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import type { PaneView } from "../lib/actions.ts";
import { RECENT_LIMIT } from "../lib/recentPanes.ts";
import type { Emit } from "../ui/bubble.ts";
import { rankPanes } from "../lib/paletteSearch.ts";
import { SHORTCUTS, formatKeys, type ShortcutId } from "../lib/shortcuts.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import { placeLine } from "../lib/paneName.ts";
import { t } from "../lib/i18n.ts";

/** The actions the palette lists; the shell runs them. */
export type PaletteActionId = "new" | "view" | "sidebar" | "theme" | "settings" | "notifications" | "lock" | "files" | "refresh";

/** What the palette draws. */
export interface CommandPaletteModel {
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  view: PaneView;
  query: string;
  /** the panes opened last on this PC, newest first */
  recent: string[];
  /** the actions this device has now (no bell once alerts are on, no sign-out without a token or pairing) */
  offers: { notifications: boolean; lock: boolean; files: boolean };
}

export type CommandPaletteEvent =
  | { type: "close-palette" }
  | { type: "palette-query"; text: string }
  | { type: "palette-pick"; paneId: string }
  | { type: "palette-run"; id: PaletteActionId };

interface PaletteAction {
  id: PaletteActionId;
  label: string;
  icon: ComponentType;
  shortcut?: ShortcutId;
}

function cwdBasename(path: string | null | undefined): string {
  if (!path) return "unknown cwd";
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function ShortcutHint({ shortcutId }: { shortcutId?: ShortcutId }) {
  if (!shortcutId) return null;
  const shortcut = SHORTCUTS.find((item) => item.id === shortcutId);
  if (!shortcut) return null;
  return <span className="palette-shortcut" aria-label={formatKeys(shortcut.keys).join(" + ")}>{formatKeys(shortcut.keys).map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</span>;
}

/** Panes and actions by search. Which row is highlighted is the view's own. */
export function CommandPalette({ model, emit }: { model: CommandPaletteModel; emit: Emit<CommandPaletteEvent> }) {
  const { snapshot, selectedPaneId, view, query, recent: recentPaneIds, offers } = model;
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const onClose = (): void => emit({ type: "close-palette" });
  const emitRef = useRef(emit);
  emitRef.current = emit;

  // Terminal attachment can move focus after the palette opens. Escape belongs to
  // this modal even then, and must not leak through to the underlying terminal.
  useLayoutEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      emitRef.current({ type: "close-palette" });
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, []);

  useEffect(() => { window.requestAnimationFrame(() => inputRef.current?.focus()); }, []);

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: "new", label: t("New session"), icon: MessageSquarePlus, shortcut: "new-session" },
    { id: "view", label: t(view === "chat" ? "Switch to terminal" : "Switch to chat"), icon: SwitchCamera, shortcut: "toggle-view" },
    { id: "sidebar", label: t("Toggle sidebar"), icon: PanelLeft, shortcut: "toggle-sidebar" },
    { id: "theme", label: t("Toggle theme"), icon: SunMoon },
    { id: "settings", label: t("Settings"), icon: Settings, shortcut: "settings" },
    ...(offers.notifications ? [{ id: "notifications" as const, label: t("Enable notifications"), icon: Bell }] : []),
    ...(offers.lock ? [{ id: "lock" as const, label: t("Sign out"), icon: LockKeyhole }] : []),
    ...(offers.files ? [{ id: "files" as const, label: t("Browse files"), icon: FolderOpen }] : []),
    { id: "refresh", label: t("Refresh"), icon: RefreshCw },
  ], [offers.notifications, offers.lock, offers.files, view, t]);

  const panes = useMemo(() => {
    const allPanes = snapshot?.panes ?? [];
    if (query.trim()) return rankPanes(query, allPanes, snapshot?.workspaces ?? []);
    const recentOrder = new Map(recentPaneIds.map((id, index) => [id, index]));
    return allPanes
      .map((pane, index) => ({ pane, index, recent: recentOrder.get(pane.pane_id) }))
      .sort((a, b) => (a.recent ?? RECENT_LIMIT + a.index) - (b.recent ?? RECENT_LIMIT + b.index))
      .map(({ pane }) => pane);
  }, [query, recentPaneIds, snapshot]);

  const visibleActions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? paletteActions.filter((action) => action.label.toLocaleLowerCase().includes(needle)) : paletteActions;
  }, [paletteActions, query]);
  const itemCount = panes.length + visibleActions.length;

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, itemCount - 1)));
  }, [itemCount]);

  const runPane = (pane: PaneInfo): void => emit({ type: "palette-pick", paneId: pane.pane_id });
  const runAction = (action: PaletteAction): void => emit({ type: "palette-run", id: action.id });
  const activate = (index: number): void => {
    if (index < panes.length) {
      const pane = panes[index];
      if (pane) runPane(pane);
      return;
    }
    const action = visibleActions[index - panes.length];
    if (action) runAction(action);
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown" && itemCount > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % itemCount);
    } else if (event.key === "ArrowUp" && itemCount > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + itemCount) % itemCount);
    } else if (event.key === "Enter" && itemCount > 0) {
      event.preventDefault();
      activate(activeIndex);
    }
  };

  return (
    <div className="modal-scrim palette-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="menu command-palette" role="dialog" aria-modal="true" aria-label={t("Command palette")} onKeyDown={onKeyDown}>
        <div className="palette-search">
          <input ref={inputRef} className="input" type="search" value={query} placeholder={t("Search panes and actions…")} aria-label={t("Search panes and actions")} aria-controls="palette-results" aria-activedescendant={itemCount ? `palette-item-${activeIndex}` : undefined} onChange={(event) => { emit({ type: "palette-query", text: event.target.value }); setActiveIndex(0); }} />
          <button type="button" className="icon-button" aria-label={t("Close command palette")} onClick={onClose}><X /></button>
        </div>
        <div className="palette-results" id="palette-results" role="listbox">
          {panes.length > 0 && <div className="menu-heading">{t("Panes")}</div>}
          {panes.map((pane, index) => {
            const workspace = snapshot?.workspaces.find((item) => item.workspace_id === pane.workspace_id);
            const selected = pane.pane_id === selectedPaneId;
            return (
              <button key={pane.pane_id} id={`palette-item-${index}`} type="button" role="option" className="menu-item palette-pane" aria-selected={activeIndex === index} onMouseEnter={() => setActiveIndex(index)} onClick={() => runPane(pane)}>
                <span className="palette-mark"><AgentMark agent={pane.agent ?? "shell"} /></span>
                <span className="menu-item-main"><span className="palette-row-title">{displayPaneTitle(pane)}{selected && <span className="palette-selected">{t("Selected")}</span>}</span><span className="palette-row-subtitle">{placeLine(workspace?.label ?? t("Unknown workspace"), cwdBasename(pane.foreground_cwd ?? pane.cwd))}</span></span>
                <StatusBadge status={pane.agent_status} />
              </button>
            );
          })}
          {visibleActions.length > 0 && <div className="menu-heading">{t("Actions")}</div>}
          {visibleActions.map((action, actionIndex) => {
            const index = panes.length + actionIndex;
            const Icon = action.icon;
            return <button key={action.id} id={`palette-item-${index}`} type="button" role="option" className="menu-item" aria-selected={activeIndex === index} onMouseEnter={() => setActiveIndex(index)} onClick={() => runAction(action)}><Icon /><span className="menu-item-main">{action.label}</span><ShortcutHint shortcutId={action.shortcut} /></button>;
          })}
          {itemCount === 0 && <p className="palette-empty" role="status">{t("No matching panes or actions")}</p>}
        </div>
      </section>
    </div>
  );
}
