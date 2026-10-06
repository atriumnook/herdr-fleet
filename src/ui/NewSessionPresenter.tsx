import { useMemo } from "react";
import { DirectoryBrowser } from "../components/DirectoryBrowser.tsx";
import { NewSessionDialog, type NewSessionEvent, type NewSessionModel } from "../components/NewSessionDialog.tsx";
import { MachineContext } from "../lib/machineContext.tsx";
import type { Emit } from "./bubble.ts";
import { useSelected } from "./presenter.ts";

/** The new session dialog's Presenter: its region, and the name of the PC it starts on. Draws nothing while closed. */
export function NewSessionPresenter({ emit }: { emit: Emit<NewSessionEvent> }) {
  const dialog = useSelected((state) => state.newSession);
  const machines = useSelected((state) => state.machines.list);
  const model = useMemo<NewSessionModel | null>(() => (dialog.open
    ? { ...dialog, machineName: machines.find((machine) => machine.id === dialog.machineId)?.name ?? dialog.machineId }
    : null), [dialog, machines]);
  if (model === null) return null;
  // the folder browser reads the folders on the dialog's PC
  return (
    <MachineContext.Provider value={model.machineId}>
      <NewSessionDialog key={model.seq} model={model} browser={(start, pick) => <DirectoryBrowser start={start} onPick={pick} />} emit={emit} />
    </MachineContext.Provider>
  );
}
