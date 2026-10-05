import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { App } from "../App.tsx";
import { ApiError, sendTestPush, authenticate, fetchBridgeHealth, fetchHealth, fetchMachines, fetchSession, pairDevice, signOut, clearFleetCooldown, closePane, closeWorkspace, moveWorkspace, renamePane, renameWorkspace, closeDoneFleetRuns, fetchDevices, fetchFleetRuns, fetchFleetUsage, fetchRemoteAccess, interruptFleetRun, refreshFleetUsage, renameDevice, revokeDevice, startPairing } from "../lib/api.ts";
import { forgetPaneViews, loadSettings, PANE_VIEW_KEY_PREFIX, saveSettings, SettingsProvider, type Settings } from "../lib/settings.ts";
import { Mediator, type EffectPorts } from "./mediator.ts";
import { MediatorContext, useSelected } from "./presenter.ts";
import { ensurePushSubscription, pushSupported, removePushSubscription, testDevicePush } from "../lib/push.ts";
import { notificationState, requestNotificationPermission, showPaneEndedNotification, showPaneStatusNotification } from "../lib/notifications.ts";
import { onNotificationTarget } from "../lib/notificationTarget.ts";
import { showDroplet } from "../lib/droplet.ts";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import { initialSelection, storeSelection } from "../lib/selection.ts";
import { takeAuthTokenFromUrl } from "../lib/authLink.ts";
import { deviceLabel, takePairCode } from "../lib/phone.ts";
import { INITIAL_STATE } from "./state.ts";

/** The Mediator's effects against this PC's server and this browser's storage. */
const FLEET_PORTS: EffectPorts = {
  loadRuns: fetchFleetRuns,
  loadUsage: fetchFleetUsage,
  refreshUsage: refreshFleetUsage,
  runRequest: async (action) => {
    if (action.kind === "interrupt") await interruptFleetRun(action.runId);
    else if (action.kind === "close-done") await closeDoneFleetRuns(action.group);
    else await clearFleetCooldown(action.key);
  },
  saveSettings,
  forgetPaneViews: () => void forgetPaneViews(),
  loadRemoteAccess: fetchRemoteAccess,
  // the demo, or an older server, has no device list (404)
  loadDevices: () => fetchDevices().catch((error: unknown) => { if (error instanceof ApiError && error.status === 404) return null; throw error; }),
  startPairing,
  renameDevice: async (id, label) => { await renameDevice(id, label); },
  revokeDevice,
  later: (ms, then) => { window.setTimeout(then, ms); },
  storeSelection,
  // a subscription the server no longer has is what the test is for: it says so, not that it failed
  testPush: () => testDevicePush().catch((error: unknown) => { if (error instanceof ApiError && error.code === "subscription_not_found") return "missing" as const; throw error; }),
  treeRequest: async (machineId, request) => {
    if (request.kind === "close-pane") await closePane(request.paneId, machineId);
    else if (request.kind === "close-workspace") await closeWorkspace(request.workspaceId, machineId);
    else if (request.kind === "rename-pane") await renamePane(request.paneId, request.label, machineId);
    else if (request.kind === "rename-workspace") await renameWorkspace(request.workspaceId, request.label, machineId);
    else await moveWorkspace(request.workspaceId, request.index, machineId);
  },
  requestPermission: async () => (notificationState() === "granted" ? "granted" : await requestNotificationPermission()),
  subscribePush: ensurePushSubscription,
  confirmPush: sendTestPush,
  removePush: removePushSubscription,
  dropIn: ({ machineId, machineName, pane, alert }) => {
    showDroplet({ machineId, paneId: pane.pane_id, agent: pane.agent ?? null, title: displayPaneTitle(pane), machine: machineName, kind: alert });
  },
  notifyPane: ({ machineId, machineName, pane, status }, open) => {
    const title = `${machineName} · ${displayPaneTitle(pane)}`;
    if (status === "ended") showPaneEndedNotification(pane.pane_id, title, open, machineId);
    else showPaneStatusNotification(pane.pane_id, title, status, open, machineId);
  },
  storeLens: (storageId, view) => {
    try { window.localStorage.setItem(`${PANE_VIEW_KEY_PREFIX}${storageId}`, view); } catch { /* private mode: the lens just stops being remembered */ }
  },
  loadAccess: fetchBridgeHealth,
  loadHealth: fetchHealth,
  loadMachines: () => fetchMachines().catch((error: unknown) => { if (error instanceof ApiError && error.status === 401) return "unauthorized" as const; throw error; }),
  authenticate,
  pairFromAddress: (code) => pairDevice(code, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0)),
  // the subscription goes first, while the cookie still lets it
  signOut: async () => {
    await removePushSubscription().catch(() => undefined);
    await signOut();
  },
  loadSession: fetchSession,
  // one stream watches every PC, even when no pane is selected
  openStream: ({ opened, event }) => {
    const events = new EventSource("/api/machines/events");
    events.onopen = opened;
    events.onmessage = (message) => {
      let payload;
      try { payload = JSON.parse(message.data); } catch { return; }
      event(payload);
    };
    return () => events.close();
  },
};

/** Hands the settings the Mediator holds to the views that read them from context (`useSettings`). */
function SettingsFromMediator({ mediator, children }: { mediator: Mediator; children: ReactNode }) {
  const settings = useSelected((state) => state.settings);
  const change = useCallback((patch: Partial<Settings>) => mediator.dispatch({ type: "change-settings", patch }), [mediator]);
  return <SettingsProvider settings={settings} onChange={change}>{children}</SettingsProvider>;
}

/**
 * The top of the component hierarchy: it owns the Mediator and provides it to the Presenters
 * below, each of which reads only the regions its view draws. Events bubble up to the Mediator
 * through the Emit each parent hands down. The legacy shell (App) is a child like any other; it
 * moves to Passive Views one part at a time.
 */
export function Root() {
  const mediator = useMemo(() => new Mediator(FLEET_PORTS, { ...INITIAL_STATE, settings: loadSettings(), selection: { ...initialSelection(), auto: false } }), []);
  // the pane a notification's address named is this window's from now on
  useEffect(() => {
    const { machineId, paneId } = mediator.getState().selection;
    storeSelection(machineId, paneId);
  }, [mediator]);
  // the page starts reading the server once: a bookmarked `#auth=` link and a scanned QR's code
  // are taken off the address as it does (twice would find them gone)
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    mediator.dispatch({ type: "boot", linkToken: takeAuthTokenFromUrl(), pairCode: takePairCode(), alerts: { permission: notificationState(), supported: pushSupported() }, visible: document.visibilityState !== "hidden" });
  }, [mediator]);
  useEffect(() => {
    // a hidden tab (or a phone app in the background) reads nothing; it catches up on return
    const onVisibility = (): void => mediator.dispatch({ type: "visibility", visible: document.visibilityState !== "hidden" });
    // pasting the auth link into an open tab navigates the fragment alone: no reload, so no boot
    const onHashChange = (): void => {
      const token = takeAuthTokenFromUrl();
      if (token !== null) mediator.dispatch({ type: "auth-link", token });
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("hashchange", onHashChange);
    // a tapped notification focuses this window and names the pane (public/sw.js)
    const offTarget = onNotificationTarget((target) => mediator.dispatch({ type: "select-pane", machineId: target.machine_id, paneId: target.pane_id }));
    return () => {
      offTarget();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [mediator]);
  return (
    <MediatorContext.Provider value={mediator}>
      <SettingsFromMediator mediator={mediator}><App emit={mediator.dispatch} /></SettingsFromMediator>
    </MediatorContext.Provider>
  );
}
