import { useEffect, useRef } from "react";
import { BackgroundTasks, type BackgroundTasksEvent } from "../components/BackgroundTasks.tsx";
import { useMachineId } from "../lib/machineContext.tsx";
import type { Emit } from "./bubble.ts";
import type { UiEvent } from "./state.ts";
import { useSelected } from "./presenter.ts";

export type BackgroundTasksUpEvent = Extract<UiEvent, { type: "open-background-tasks" | "close-background-tasks" }>;

/**
 * The background tasks list's Presenter: its region while it is open on this pane, and the
 * count the pane's status gives. The events go up naming the pane; the list closes when the
 * composer it is in goes (another pane, another lens), as nothing shows it any more.
 */
export function BackgroundTasksPresenter({ paneId, count, omo, emit }: { paneId: string; count: number; omo: boolean; emit: Emit<BackgroundTasksUpEvent> }) {
  const machineId = useMachineId();
  const list = useSelected((state) => state.backgroundTasks);
  const here = list.open?.machineId === machineId && list.open.paneId === paneId;
  const up = (event: BackgroundTasksEvent): void => emit({ ...event, machineId, paneId });
  const close = useRef(() => {});
  close.current = () => emit({ type: "close-background-tasks", machineId, paneId });
  useEffect(() => () => close.current(), []);
  return <BackgroundTasks model={{ count, omo, open: here, activity: here ? list.activity : null, failed: here && list.failed }} emit={up} />;
}
