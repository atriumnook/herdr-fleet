import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Bell, FolderOpen, Lock, Menu, MessageSquare, Orbit, PanelLeft, Search, SquareTerminal, X } from "lucide-react";

import { closePaneEvent, displayPaneTitle, type SidebarEvent } from "./components/Sidebar.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { AgentMark } from "./components/AgentMark.tsx";
import type { SettingsDialogEvent } from "./components/SettingsDialog.tsx";
import { useInstallPrompt } from "./lib/install.ts";
import type { CommandPaletteEvent, PaletteActionId } from "./components/CommandPalette.tsx";
import { MachineContext } from "./lib/machineContext.tsx";
import type { MachineSidebarEvent } from "./components/MachineSidebar.tsx";
import { Segmented } from "./components/Segmented.tsx";
import { paneStorageId, type Machine } from "../shared/machines.ts";
import { useSettings, type DefaultView } from "./lib/settings.ts";
import { useShortcuts } from "./lib/shortcuts.ts";
import type { AppActions, PaneView } from "./lib/actions.ts";
import { pushSupported } from "./lib/push.ts";
import { OpenFileContext } from "./lib/filePaths.ts";
import { t } from "./lib/i18n.ts";
import { useScreenWakeLock } from "./lib/wakeLock.ts";
import { watchDrawerSwipe } from "./lib/edgeSwipe.ts";
import { relay, type Emit } from "./ui/bubble.ts";
import { paneFromUrl } from "./lib/selection.ts";
import { needsCount } from "./ui/fleetView.ts";
import { DevicesPanelPresenter } from "./ui/DevicesPanelPresenter.tsx";
import { FleetPresenter, ProjectRailPresenter } from "./ui/FleetPresenter.tsx";
import { NewSessionPresenter } from "./ui/NewSessionPresenter.tsx";
import { AccessGatePresenter } from "./ui/AccessGatePresenter.tsx";
import { CommandPalettePresenter } from "./ui/CommandPalettePresenter.tsx";
import { FilesDialogPresenter } from "./ui/FilesDialogPresenter.tsx";
import { FileViewerPresenter } from "./ui/FileViewerPresenter.tsx";
import { DropletPresenter } from "./ui/DropletPresenter.tsx";
import { MachineSidebarPresenter } from "./ui/MachineSidebarPresenter.tsx";
import { SidebarPresenter } from "./ui/SidebarPresenter.tsx";
import { PushTestPresenter } from "./ui/PushTestPresenter.tsx";
import { useSelected } from "./ui/presenter.ts";
import { SettingsDialogPresenter } from "./ui/SettingsDialogPresenter.tsx";
import { SIDE_LENSES, type Lens, type UiEvent } from "./ui/state.ts";

const APP_TITLE = "herdr fleet";
/**
 * The lens a pane opens in: remembered per pane. A pane seen for the first time opens its
 * terminal, except an agent pane on a touch screen, which opens its chat: a phone reads a
 * conversation better than a TUI sized for a desktop. Until the snapshot says whether the
 * pane has an agent (null), a touch screen guesses chat: most panes opened there are agents,
 * and guessing terminal flashed it for the seconds before the snapshot arrived. A PC whose
 * herdr has no terminal attach and no mirror either (an older Windows bridge) always opens
 * its chat: its terminal lens is only a notice, so a remembered choice there is not worth
 * keeping. A mirrored PC counts as having a terminal.
 */
function storedView(paneId: string, machineId: string, hasAgent: boolean | null, terminalAttach: boolean, defaultView: DefaultView): PaneView {
  if (!terminalAttach) return "chat";
  try {
    const stored = window.localStorage.getItem(`herdr-fleet:view:${paneStorageId(machineId, paneId)}`);
    if (stored === "chat" || stored === "terminal") return stored;
  } catch {
    /* private mode */
  }
  // Settings' choice for every pane: chat needs an agent, a shell has no conversation to show
  if (defaultView === "chat") return hasAgent !== false ? "chat" : "terminal";
  if (defaultView === "terminal") return "terminal";
  return hasAgent !== false && window.matchMedia?.("(pointer: coarse)").matches === true ? "chat" : "terminal";
}

/** The chat that holds the focus: the one beside on the Fleet screen or the side chat, else the pane's (the keys and the palette's prompts go to it). */
function focusedChat(): Lens {
  const lens = document.activeElement?.closest("[data-chat-lens]")?.getAttribute("data-chat-lens");
  return lens === "side" || lens === "side-chat" ? lens : "main";
}

function Brand() {
  return (
    <h1 className="brand">
      <img src="/icons/icon-192.png?v=ram1" alt="" width="22" height="22" className="brand-mark" />
      <span className="brand-name">
        herdr <span className="brand-sub">web ui</span>
      </span>
    </h1>
  );
}

/**
 * The legacy shell, under the Root: it reads what it draws of the Mediator's state (the screen,
 * the runs waiting on the person, a pane the Mediator asks for) and sends events up through `emit`.
 */
export function App({ emit }: { emit: Emit<UiEvent> }) {
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const screen = useSelected((state) => state.screen);
  const needs = useSelected(needsCount);
  const selection = useSelected((state) => state.selection);
  const selectedMachineId = selection.machineId;
  const selectedPaneId = selection.paneId;
  // App picked the selected pane itself because the one selected closed: it must not raise a
  // phone's keyboard (over the drawer the close was tapped in) until the user picks a pane or lens
  const autoSelected = selection.auto;
  const { settings, resolvedTheme, update: updateSettings } = useSettings();
  // the bell's switch for this device: off drops its push subscription and silences tab alerts
  const alertsOn = settings.alertsOn;
  // the server, as the Mediator reads it: each value on its own, so a poll that changed nothing re-renders nothing
  const machines = useSelected((state) => state.machines.list);
  const error = useSelected((state) => state.machines.error);
  const health = useSelected((state) => state.connection.health);
  // null until the server has said whether it wants a token: the shell, and with it
  // the WebSocket, never mounts before that is known
  const locked = useSelected((state) => state.connection.locked);
  const auth = useSelected((state) => state.connection.auth);
  const selectedMachine = machines.find((m) => m.id === selectedMachineId);
  const snapshot = selectedMachine?.snapshot ?? null;
  const canSignOut = auth?.authenticated === true && (auth.via === "token" || auth.via === "device");
  const drawerOpen = useSelected((state) => state.drawerOpen);
  const drawerOpenRef = useRef(drawerOpen); drawerOpenRef.current = drawerOpen;
  const setDrawerOpen = useCallback((open: boolean) => emitRef.current({ type: "drawer", open }), []);
  const selectionRef = useRef({ machineId: selectedMachineId, paneId: selectedPaneId });
  selectionRef.current = { machineId: selectedMachineId, paneId: selectedPaneId };
  // on a phone the drawer follows a swipe in from the left edge, and a swipe back (lib/edgeSwipe.ts)
  useEffect(() => watchDrawerSwipe(() => drawerOpenRef.current, setDrawerOpen), []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const lensChoice = useSelected((state) => state.pane.lens);
  // a file path in the chat or the terminal, read from the selected pane's folder
  const viewFile = useCallback((path: string) => emit({ type: "open-file", path }), [emit]);
  // the install prompt is the browser's: the Settings dialog asks for it, and this shell handles it
  const installPrompt = useInstallPrompt();
  const settingsEmit = useMemo(() => relay<SettingsDialogEvent, UiEvent>(emit, (event, pass) => {
    if (event.type === "install-app") void installPrompt.install();
    else pass(event);
  }), [emit, installPrompt.install]);
  // the selected pane's folder: a new session on its PC starts there
  const selectedCwdRef = useRef<string | null>(null);
  // the open pane's socket, as the Mediator keeps it
  const connected = useSelected((state) => state.pane.connected);
  const outputStopped = useSelected((state) => state.pane.outputStopped);
  const role = useSelected((state) => state.pane.role);
  // this device's alerts, as the Mediator keeps them: the browser's permission, and whether
  // the server pushes them (else the tab tells them itself)
  const notifications = useSelected((state) => state.alerts.permission);
  const pushOn = useSelected((state) => state.alerts.push);
  const snapshotRef = useRef<typeof snapshot>(null);
  snapshotRef.current = snapshot;

  const enableNotifications = useCallback(() => emitRef.current({ type: "enable-alerts" }), []);
  const disableNotifications = useCallback(() => emitRef.current({ type: "disable-alerts" }), []);
  const lock = useCallback(() => emitRef.current({ type: "sign-out" }), []);

  const selectedMachineRef = useRef(selectedMachineId);
  selectedMachineRef.current = selectedMachineId;
  const selectPane = useCallback((paneId: string) => {
    emitRef.current({ type: "select-pane", machineId: selectedMachineRef.current, paneId });
  }, []);

  // the pane stays attached under the Fleet screen, out of reach of focus and screen readers
  const paneLayerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    paneLayerRef.current?.toggleAttribute("inert", screen === "fleet");
  }, [screen]);

  // a new session on a PC: this shell adds the folder it starts in (a project's root when started
  // from its heading, else the selected pane's, on its PC)
  const openNewSession = useCallback((machineId: string, cwd?: string) => {
    emitRef.current({ type: "open-new-session", machineId, defaultCwd: cwd ?? (machineId === selectedMachineRef.current ? selectedCwdRef.current : null) });
  }, []);
  // the sidebar: a new session and the install prompt are this shell's
  const sidebarEmit = useMemo(() => relay<MachineSidebarEvent, UiEvent>(emit, (event, pass) => {
    if (event.type === "new-session") openNewSession(event.machineId);
    else if (event.type === "install-app") void installPrompt.install();
    else if (event.type === "select-pane") pass(event);
    else { setDrawerOpen(false); pass(event); }
  }), [emit, openNewSession, installPrompt.install, setDrawerOpen]);

  // the Fleet screen's projects: one picked closes the phone's drawer
  const railEmit = useMemo(() => relay<UiEvent, UiEvent>(emit, (event, pass) => {
    if (event.type === "fleet-project" || event.type === "fleet-settings") setDrawerOpen(false);
    pass(event);
  }), [emit, setDrawerOpen]);

  // the ?pane= a notification opened us with has done its job once it selected the pane
  useEffect(() => {
    if (paneFromUrl() !== null) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  selectedCwdRef.current = selectedPane?.cwd ?? null;
  useScreenWakeLock(settings.keepScreenOn && locked === false && selectedPane !== null);
  const selectedWorkspace = selectedPane
    ? (snapshot?.workspaces.find((workspace) => workspace.workspace_id === selectedPane.workspace_id) ?? null)
    : null;
  const targetHerdr = selectedMachineId === "local" ? health?.herdr : selectedMachine?.herdr;
  const selectedTitle = selectedPane ? displayPaneTitle(selectedPane) : null;
  const selectedAgent = selectedPane?.agent ?? null;
  // unknown herdr (offline, or a server that predates the flag) counts as attach-capable
  // a server that repaints the pane's screen instead (terminal_mirror) has a terminal lens too
  const terminalAttach = targetHerdr?.terminal_attach !== false || targetHerdr?.terminal_mirror === true;

  // the lens follows the selected pane, each remembering its own. It is read as the pane is drawn:
  // read after, a pane showed for a frame in the lens of the one before, and the message box of
  // that chat lens took the keyboard from the terminal being opened
  const hasAgent = selectedPane ? selectedAgent !== null : null;
  // a choice holds while the pane and what decides its lens stay as they were
  const lensKey = `${selectedPaneId === null ? "" : paneStorageId(selectedMachineId, selectedPaneId)}\n${settings.defaultView}\n${terminalAttach}`;
  const storedLens = useMemo(
    () => (selectedPaneId === null ? "terminal" : storedView(selectedPaneId, selectedMachineId, hasAgent, terminalAttach, settings.defaultView)),
    [selectedPaneId, selectedMachineId, hasAgent, terminalAttach, settings.defaultView],
  );
  const view: PaneView = lensChoice !== null && lensChoice.key === lensKey ? lensChoice.view : storedLens;

  const setView = useCallback(
    (next: PaneView) => emitRef.current({ type: "choose-lens", key: lensKey, storageId: selectedPaneId === null ? null : paneStorageId(selectedMachineId, selectedPaneId), view: next }),
    [selectedPaneId, selectedMachineId, lensKey],
  );

  const bell: { label: string; title: string; on: boolean; run: () => void } =
    notifications !== "granted"
      ? { label: t("Enable notifications"), title: t("Notify me when a pane needs you or is done."), on: false, run: enableNotifications }
      : !alertsOn
        ? { label: t("Alerts off"), title: t("Alerts are off on this device. Tap to turn them on."), on: false, run: enableNotifications }
        : pushOn
          ? { label: t("Alerts on"), title: t("Alerts on — pushed to this device, even with the app closed. Tap to turn them off."), on: true, run: disableNotifications }
          : {
              label: t("Alerts on in this tab"),
              // turning them off and on again retries the push subscription
              title: pushSupported()
                ? t("Alerts on while this tab is open. Tap to turn them off.")
                : t("Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off."),
              on: true,
              run: disableNotifications,
            };
  const bellVisible = notifications !== "unsupported" && notifications !== "denied";

  useEffect(() => {
    document.title = selectedTitle ? `${selectedTitle} · herdr` : APP_TITLE;
  }, [selectedTitle]);

  // a chat shows and has its conversation open: the Pane screen's chat lens, the Fleet screen's
  // project conversation or the thread beside it (a chat opens itself while it is mounted). The
  // Fleet screen with no conversation open has no prompt to step to.
  const chatShows = useSelected((state) => state.chat.open !== null || SIDE_LENSES.some((lens) => state.lenses[lens].chat.open !== null));
  const actions = useMemo<AppActions>(
    () => ({
      selectPane,
      selectAdjacentPane: (direction) => {
        const panes = snapshotRef.current?.panes ?? [];
        if (panes.length === 0) return;
        const index = panes.findIndex((pane) => pane.pane_id === selectedPaneId);
        const next = panes[(index + direction + panes.length) % panes.length];
        if (next) selectPane(next.pane_id);
      },
      stepPrompt: chatShows ? (direction) => {
        const lens = focusedChat();
        emitRef.current({ type: "prompt-rail-step", direction, ...(lens === "main" ? {} : { lens }) });
      } : null,
      setView,
      toggleView: () => setView(view === "chat" ? "terminal" : "chat"),
      openNewSession: () => openNewSession(selectedMachineId),
      openPalette: () => emitRef.current({ type: "open-palette", chat: focusedChat() }),
      openSettings: () => {
        setDrawerOpen(false);
        emitRef.current({ type: "open-settings" });
      },
      toggleSidebar: () => {
        if (window.matchMedia("(max-width: 768px)").matches) emitRef.current({ type: "toggle-drawer" });
        else setSidebarCollapsed((collapsed) => !collapsed);
      },
      toggleTheme: () => updateSettings({ theme: resolvedTheme === "dark" ? "light" : "dark" }),
      lock: canSignOut ? () => void lock() : null,
      enableNotifications: bellVisible && !bell.on ? () => void enableNotifications() : null,
      refresh: () => emitRef.current({ type: "reload-machines" }),
      openFiles: selectedPaneId !== null ? () => emitRef.current({ type: "open-files" }) : null,
    }),
    [selectPane, selectedPaneId, selectedMachineId, setView, view, chatShows, updateSettings, resolvedTheme, canSignOut, lock, bellVisible, bell.on, enableNotifications],
  );
  // a connected PC's sessions: a new session is this shell's; the rest goes up as it is
  const treeEmit = useMemo(() => relay<SidebarEvent, UiEvent>(emit, (event, pass) => {
    if (event.type === "new-session") openNewSession(event.machineId, event.cwd);
    else pass(event);
  }), [emit, openNewSession]);
  const machineTree = useCallback((machine: Machine) => (
    <SidebarPresenter machineId={machine.id} snapshot={machine.snapshot} selectedPaneId={selectedMachineId === machine.id ? selectedPaneId : null} emit={treeEmit} />
  ), [selectedMachineId, selectedPaneId, treeEmit]);

  // the palette's actions are this shell's: run, and the palette closes
  const paletteOffers = useMemo(() => ({ notifications: actions.enableNotifications !== null, lock: actions.lock !== null, files: actions.openFiles !== null, pane: selectedPane !== null, prompts: actions.stepPrompt !== null }), [actions, selectedPane]);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const selectedRef = useRef({ machineId: selectedMachineId, pane: selectedPane });
  selectedRef.current = { machineId: selectedMachineId, pane: selectedPane };
  // the selected pane's rename happens in its sidebar row: the row comes into view first (the
  // drawer opens on a phone, a collapsed sidebar shows on a desktop), then its name field opens
  const renameSelectedPane = useCallback(() => {
    const { machineId, pane } = selectedRef.current;
    if (!pane) return;
    if (window.matchMedia("(max-width: 768px)").matches) emitRef.current({ type: "drawer", open: true });
    else setSidebarCollapsed(false);
    emitRef.current({ type: "tree-start-pane-rename", machineId, paneId: pane.pane_id, label: pane.label ?? "" });
  }, []);
  const closeSelectedPane = useCallback(() => {
    const { machineId, pane } = selectedRef.current;
    if (!pane) return;
    const paneCount = snapshotRef.current?.panes.filter((other) => other.workspace_id === pane.workspace_id).length ?? 1;
    emitRef.current(closePaneEvent(machineId, pane.pane_id, displayPaneTitle(pane), paneCount));
  }, []);
  const paletteEmit = useMemo(() => relay<CommandPaletteEvent, UiEvent>(emit, (event, pass) => {
    if (event.type !== "palette-run") { pass(event); return; }
    const run: Record<PaletteActionId, (() => void) | null> = {
      new: actionsRef.current.openNewSession,
      view: actionsRef.current.toggleView,
      "rename-pane": renameSelectedPane,
      "close-pane": closeSelectedPane,
      sidebar: actionsRef.current.toggleSidebar,
      theme: actionsRef.current.toggleTheme,
      settings: actionsRef.current.openSettings,
      notifications: actionsRef.current.enableNotifications,
      lock: actionsRef.current.lock,
      files: actionsRef.current.openFiles,
      refresh: actionsRef.current.refresh,
    };
    run[event.id]?.();
    pass({ type: "close-palette" });
  }), [emit, renameSelectedPane, closeSelectedPane]);

  useShortcuts(actions, locked === false);

  if (locked === null) {
    // the auth state is unknown until /api/health or /api/session answers (ten seconds when
    // herdr is down): show the shell without the terminal, and so without a WebSocket,
    // instead of a blank page
    return (
      <div className="app">
        <header className="app-header">
          <Brand />
        </header>
        <div className="app-body">
          <aside className="sidebar">
            <p className="tree-state" role="status">
              Connecting…
            </p>
          </aside>
          <main className="terminal-host">
            <div className="terminal-placeholder">
              <div className="terminal-placeholder-inner">
                <span>{t("Connecting to herdr fleet…")}</span>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }
  if (locked) return <AccessGatePresenter emit={emit} />;

  return (
    <MachineContext.Provider value={selectedMachineId}><div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <header className="app-header">
        <button
          type="button"
          className="icon-button drawer-toggle"
          aria-label={t(drawerOpen ? "Close workspace list" : "Open workspace list")}
          aria-expanded={drawerOpen}
          aria-controls="workspace-drawer"
          onClick={() => emit({ type: "toggle-drawer" })}
        >
          {drawerOpen ? <X /> : <Menu />}
        </button>
        <button
          type="button"
          className="icon-button header-desktop-only sidebar-toggle"
          aria-label={t(sidebarCollapsed ? "Show workspace list" : "Hide workspace list")}
          aria-pressed={!sidebarCollapsed}
          title={t("Toggle sidebar (⌘⇧B)")}
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        >
          <PanelLeft />
        </button>
        {selectedPane ? (
          <div className="context" title={`${selectedWorkspace?.label ?? selectedPane.workspace_id} › ${selectedTitle}`}>
            <div className="context-title">
              {selectedAgent && <AgentMark agent={selectedAgent} size={18} />}
              <span className="context-title-text">{selectedTitle}</span>
            </div>
            <div className="context-sub">
              <span className="machine-context-name">{selectedMachine?.name ?? selectedMachineId}</span><span aria-hidden="true"> › </span>
              <span>{selectedWorkspace?.label ?? selectedPane.workspace_id}</span>
              {selectedPane.cwd && (
                <>
                  <span className="context-sep" aria-hidden="true">
                    ›
                  </span>
                  <span>{selectedPane.cwd}</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <><Brand /><span className="machine-context-name">{selectedMachine?.name ?? selectedMachineId}</span></>
        )}
        <Segmented label={t("Screen")} className="screen-switch">
          <button type="button" aria-pressed={screen === "pane"} title={t("Pane")} onClick={() => emit({ type: "show-screen", screen: "pane" })}>
            <AppWindow />
            <span className="header-desktop-only">{t("Pane")}</span>
          </button>
          <button
            type="button"
            className={`fleet-button${needs > 0 ? " has-needs" : ""}`}
            aria-label={needs > 0 ? t("Fleet: {count} need you", { count: needs }) : t("Fleet")}
            aria-pressed={screen === "fleet"}
            title={t("Fleet")}
            onClick={() => emit({ type: "show-screen", screen: "fleet" })}
          >
            <Orbit />
            <span className="header-desktop-only">{t("Fleet")}</span>
            {needs > 0 && <span className="fleet-button-count" aria-hidden="true">{needs}</span>}
          </button>
        </Segmented>
        {selectedPane && screen === "pane" && (
          <Segmented label={t("Pane view")} className="view-switch">
            <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")} title={t("Chat transcript (⌘⇧J)")}>
              <MessageSquare />
              <span className="header-desktop-only">{t("Chat")}</span>
            </button>
            <button type="button" aria-pressed={view === "terminal"} onClick={() => setView("terminal")} title={terminalAttach ? t("Live terminal (⌘⇧J)") : t("Live terminal comes to Windows PCs once herdr can attach there.")}>
              <SquareTerminal />
              <span className="header-desktop-only">{t("Terminal")}</span>
              {!terminalAttach && <span className="pill pill-soon">{t("soon")}</span>}
            </button>
          </Segmented>
        )}
        <div className="header-meta">
          <span
            className={`conn ${connected ? "conn-live" : "conn-reconnecting"}`}
            role="status"
            title={targetHerdr ? t("herdr {version} · protocol {protocol}", { version: targetHerdr.version, protocol: targetHerdr.protocol }) : undefined}
          >
            <span className="conn-dot" aria-hidden="true" />
            <span className="conn-text">{t(connected ? "live" : outputStopped ? "disconnected" : "reconnecting")}</span>
          </span>
          {!targetHerdr && <span className="pill pill-offline">{t("herdr offline")}</span>}
          {selectedPane && (
            <button type="button" className="icon-button files-button" aria-label={t("Browse files")} title={t("Browse files")} onClick={() => emit({ type: "open-files" })}>
              <FolderOpen />
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t("Command palette")} title={t("Command palette (⌘⇧K)")} onClick={() => emit({ type: "open-palette" })}>
            <Search />
          </button>
          {bellVisible && (
            <button
              type="button"
              className={`icon-button bell-button${bell.on ? " is-on" : ""}`}
              aria-label={bell.label}
              aria-pressed={bell.on}
              title={bell.title}
              onClick={() => void bell.run()}
            >
              <Bell />
            </button>
          )}
          {canSignOut && (
            <button type="button" className="icon-button lock-button header-desktop-only" aria-label={t("Sign out")} title={t("Sign out")} onClick={() => void lock()}>
              <Lock />
            </button>
          )}
        </div>
      </header>

      <div className="app-body">
        <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}`}>
          {error && <div className="error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => emit({ type: "reload-machines" })}>{t("Retry")}</button></div>}
          {screen === "fleet"
            ? <ProjectRailPresenter emit={railEmit} />
            : <MachineSidebarPresenter version={health?.herdr?.version ?? null} machines={machines} install={installPrompt} tree={machineTree} emit={sidebarEmit} />}
        </aside>

        {drawerOpen && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}

        {/* a file path in the chat opens in the viewer, relative to the selected pane's folder */}
        <OpenFileContext.Provider value={selectedPaneId !== null ? viewFile : null}>
        <main className="terminal-host">
          <div className="pane-layer" ref={paneLayerRef}>
          <PaneTerminal
            key={selectedMachineId}
            paneId={selectedPane?.restore_error ? null : selectedPaneId}
            restoreError={selectedPane?.restore_error ?? null}
            agent={selectedAgent}
            agentStatus={selectedPane?.agent_status}
            view={view}
            chatShown={screen === "pane"}
            autoSelected={autoSelected}
            terminalFontSize={settings.terminalFontSize}
            terminalWheelSpeed={settings.terminalWheelSpeed}
            terminalFontFamily={settings.terminalFontFamily}
            theme={resolvedTheme}
            role={role}
            emit={emit}
          />
          </div>
          {screen === "fleet" && <FleetPresenter emit={emit} />}
        </main>
        </OpenFileContext.Provider>
      </div>

      <NewSessionPresenter emit={emit} />
      <DropletPresenter emit={emit} />
      <SettingsDialogPresenter
        install={installPrompt}
        alerts={<PushTestPresenter emit={emit} />}
        devices={(pairUrl) => <DevicesPanelPresenter pairUrl={pairUrl} auth={auth} emit={emit} />}
        emit={settingsEmit}
      />
      <FilesDialogPresenter start={selectedPane ? selectedPane.foreground_cwd ?? selectedPane.cwd ?? "" : null} emit={emit} />
      <FileViewerPresenter emit={emit} />
      <CommandPalettePresenter snapshot={snapshot} selectedPaneId={selectedPaneId} view={view} offers={paletteOffers} emit={paletteEmit} />
    </div></MachineContext.Provider>
  );
}
