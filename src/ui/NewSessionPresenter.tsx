import { useMemo } from "react";
import { NewSessionDialog, type NewSessionEvent, type NewSessionModel } from "../components/NewSessionDialog.tsx";
import { MachineContext } from "../lib/machineContext.tsx";
import { projectAt } from "../lib/projectGroups.ts";
import type { Emit } from "./bubble.ts";
import { DirectoryBrowserPresenter, type FolderBrowserUpEvent } from "./DirectoryBrowserPresenter.tsx";
import { useSelected } from "./presenter.ts";

/**
 * The new session dialog's Presenter: its region, the name of the PC it starts on, and the project
 * the folder lies in when that project already has workspaces. Draws nothing while closed.
 */
export function NewSessionPresenter({ emit }: { emit: Emit<NewSessionEvent | FolderBrowserUpEvent> }) {
  const dialog = useSelected((state) => state.newSession);
  const machines = useSelected((state) => state.machines.list);
  const model = useMemo<NewSessionModel | null>(() => {
    if (!dialog.open) return null;
    const machine = machines.find((candidate) => candidate.id === dialog.machineId);
    const project = projectAt(machine?.snapshot?.workspaces ?? [], dialog.cwd);
    return { ...dialog, machineName: machine?.name ?? dialog.machineId, project: project?.repo ? { name: project.repo.name, workspaces: project.workspaces.length } : null };
  }, [dialog, machines]);
  if (model === null) return null;
  // the folder browser reads the folders on the dialog's PC
  return (
    <MachineContext.Provider value={model.machineId}>
      <NewSessionDialog key={model.seq} model={model} browser={(start, pick) => <DirectoryBrowserPresenter slot="new-session" start={start} onPick={pick} emit={emit} />} emit={emit} />
    </MachineContext.Provider>
  );
}
