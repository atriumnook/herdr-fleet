import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { App } from "../App.tsx";
import { clearFleetCooldown, closeDoneFleetRuns, fetchFleetRuns, fetchFleetUsage, interruptFleetRun, refreshFleetUsage } from "../lib/api.ts";
import { fleetScreenModel, needsCount } from "./fleetView.ts";
import { Mediator, type EffectPorts } from "./mediator.ts";

/** how often the drawn values look at the time again (a reset window, an ended cooldown) */
const MODEL_CLOCK_MS = 15_000;

/** The Mediator's effects against this PC's server. */
const FLEET_PORTS: EffectPorts = {
  loadRuns: fetchFleetRuns,
  loadUsage: fetchFleetUsage,
  refreshUsage: refreshFleetUsage,
  runRequest: async (action) => {
    if (action.kind === "interrupt") await interruptFleetRun(action.runId);
    else if (action.kind === "close-done") await closeDoneFleetRuns(action.group);
    else await clearFleetCooldown(action.key);
  },
};

/**
 * The top of the component hierarchy: it owns the Mediator, reads its state, and hands every view
 * below the values it draws and the Emit its events bubble up through. The legacy shell (App) is
 * a child like any other; it moves to Passive Views one part at a time.
 */
export function Root() {
  const mediator = useMemo(() => new Mediator(FLEET_PORTS), []);
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
    emit: mediator.dispatch,
  }), [state, now, mediator]);
  return <App shell={shell} />;
}
