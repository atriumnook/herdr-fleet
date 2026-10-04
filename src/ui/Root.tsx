import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { App } from "../App.tsx";
import { clearFleetCooldown, closeDoneFleetRuns, fetchFleetRuns, fetchFleetUsage, fetchRemoteAccess, interruptFleetRun, refreshFleetUsage } from "../lib/api.ts";
import { forgetPaneViews, loadSettings, saveSettings, SettingsProvider, type Settings } from "../lib/settings.ts";
import { fleetScreenModel, needsCount } from "./fleetView.ts";
import { Mediator, type EffectPorts } from "./mediator.ts";
import { settingsDialogModel } from "./settingsView.ts";
import { INITIAL_STATE } from "./state.ts";

/** how often the drawn values look at the time again (a reset window, an ended cooldown) */
const MODEL_CLOCK_MS = 15_000;

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
};

/**
 * The top of the component hierarchy: it owns the Mediator, reads its state, and hands every view
 * below the values it draws and the Emit its events bubble up through. The settings reach the
 * views that still read them from context (`useSettings`) through the SettingsProvider. The legacy
 * shell (App) is a child like any other; it moves to Passive Views one part at a time.
 */
export function Root() {
  const mediator = useMemo(() => new Mediator(FLEET_PORTS, { ...INITIAL_STATE, settings: loadSettings() }), []);
  const state = useSyncExternalStore(mediator.subscribe, mediator.getState);
  // windows reset and cooldowns end with time alone: the values drawn follow a clock as well
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MODEL_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const shell = useMemo(() => ({
    screen: state.screen,
    fleet: fleetScreenModel(state, now),
    needs: needsCount(state),
    paneRequest: state.paneRequest,
    settingsDialog: settingsDialogModel(state, { protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }),
    emit: mediator.dispatch,
  }), [state, now, mediator]);
  const changeSettings = useCallback((patch: Partial<Settings>) => mediator.dispatch({ type: "change-settings", patch }), [mediator]);
  return <SettingsProvider settings={state.settings} onChange={changeSettings}><App shell={shell} /></SettingsProvider>;
}
