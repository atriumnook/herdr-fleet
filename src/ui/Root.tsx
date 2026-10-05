import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { App } from "../App.tsx";
import { ApiError, clearFleetCooldown, closeDoneFleetRuns, fetchDevices, fetchFleetRuns, fetchFleetUsage, fetchRemoteAccess, interruptFleetRun, refreshFleetUsage, renameDevice, revokeDevice, startPairing } from "../lib/api.ts";
import { forgetPaneViews, loadSettings, saveSettings, SettingsProvider, type Settings } from "../lib/settings.ts";
import { Mediator, type EffectPorts } from "./mediator.ts";
import { MediatorContext, useSelected } from "./presenter.ts";
import { testDevicePush } from "../lib/push.ts";
import { initialSelection, storeSelection } from "../lib/selection.ts";
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
  return (
    <MediatorContext.Provider value={mediator}>
      <SettingsFromMediator mediator={mediator}><App emit={mediator.dispatch} /></SettingsFromMediator>
    </MediatorContext.Provider>
  );
}
