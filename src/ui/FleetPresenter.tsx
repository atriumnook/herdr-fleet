import { useEffect, useMemo, useState } from "react";
import { FleetScreen, type FleetScreenEvent } from "../components/fleet/FleetScreen.tsx";
import type { Emit } from "./bubble.ts";
import { FLEET_REGIONS, fleetScreenModel } from "./fleetView.ts";
import { useRegions } from "./presenter.ts";

/** how often the drawn values look at the time again (a reset window, an ended cooldown) */
const MODEL_CLOCK_MS = 15_000;

/**
 * The Fleet screen's Presenter: it reads the fleet's regions and keeps the clock the values
 * follow (windows reset and cooldowns end with time alone), only while the screen is shown.
 */
export function FleetPresenter({ emit }: { emit: Emit<FleetScreenEvent> }) {
  const fleet = useRegions(...FLEET_REGIONS);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MODEL_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const model = useMemo(() => fleetScreenModel(fleet, now), [fleet, now]);
  return <FleetScreen model={model} emit={emit} />;
}
