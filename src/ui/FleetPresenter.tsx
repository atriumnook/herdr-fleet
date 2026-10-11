import { useEffect, useMemo, useState } from "react";
import { FleetScreen } from "../components/fleet/FleetScreen.tsx";
import { ProjectRail, type ProjectRailEvent } from "../components/fleet/ProjectRail.tsx";
import type { Emit } from "./bubble.ts";
import { DirectoryBrowserPresenter, type FolderBrowserUpEvent } from "./DirectoryBrowserPresenter.tsx";
import { FLEET_REGIONS, fleetScreenModel, projectsOf } from "./fleetView.ts";
import { PaneChatPresenter } from "./PaneChatPresenter.tsx";
import { useRegions } from "./presenter.ts";
import type { UiEvent } from "./state.ts";
import { MachineContext } from "../lib/machineContext.tsx";

/** how often the drawn values look at the time again (a reset window, an ended cooldown) */
const MODEL_CLOCK_MS = 15_000;

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MODEL_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The Fleet screen's Presenter: it reads the fleet's regions, keeps the clock the values follow
 * (windows reset and cooldowns end with time alone), and puts the project conversation and the
 * open thread's or agent's pane in as chats, the first on the pane's chat and the other beside it.
 */
export function FleetPresenter({ emit }: { emit: Emit<UiEvent> }) {
  const fleet = useRegions(...FLEET_REGIONS);
  const now = useClock();
  const model = useMemo(() => fleetScreenModel(fleet, now), [fleet, now]);
  const { coordinator, open, threads } = model;
  const conversation = coordinator
    ? <PaneChatPresenter key={coordinator.paneId} runId={coordinator.runId} paneId={coordinator.paneId} agent={coordinator.agent} ended={false} lens="main" threads={threads} emit={emit} />
    : null;
  const side = open
    ? <PaneChatPresenter key={open.paneId} runId={open.paneRunId} paneId={open.paneId} agent={open.agent} ended={open.ended} lens="side" emit={emit} />
    : null;
  return <FleetScreen model={model} conversation={conversation} side={side} emit={emit} />;
}

/** The Fleet screen's sidebar Presenter: the projects, a folder browser for a new one, the usage. */
export function ProjectRailPresenter({ emit }: { emit: Emit<ProjectRailEvent | FolderBrowserUpEvent> }) {
  const fleet = useRegions(...FLEET_REGIONS);
  const now = useClock();
  const model = useMemo(() => {
    const screen = fleetScreenModel(fleet, now);
    return { projects: projectsOf(fleet).list, usage: screen.usage, canAct: fleet.canAct, now };
  }, [fleet, now]);
  // fleet projects are folders on this PC
  return (
    <MachineContext.Provider value="local">
      <ProjectRail model={model} browser={(pick) => <DirectoryBrowserPresenter slot="fleet-project" start="" onPick={pick} emit={emit} />} emit={emit} />
    </MachineContext.Provider>
  );
}
