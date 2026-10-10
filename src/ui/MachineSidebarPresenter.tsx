import { useMemo, type ReactNode } from "react";
import type { Machine } from "../../shared/machines.ts";
import { MachineSidebar, type MachineSidebarEvent, type MachineSidebarModel } from "../components/MachineSidebar.tsx";
import type { Emit } from "./bubble.ts";
import { useSelected } from "./presenter.ts";

export interface MachineSidebarPresenterProps {
  /** the PCs and their sessions, as the shell's event stream keeps them */
  machines: Machine[];
  version: string | null;
  install: MachineSidebarModel["install"];
  tree: (machine: Machine) => ReactNode;
  emit: Emit<MachineSidebarEvent>;
}

/** The sidebar's Presenter: the PCs the shell keeps, with the selected pane from the Mediator. */
export function MachineSidebarPresenter({ machines, version, install, tree, emit }: MachineSidebarPresenterProps) {
  const selection = useSelected((state) => state.selection);
  const model = useMemo<MachineSidebarModel>(() => ({
    machines, version, install: { installed: install.installed, canInstall: install.canInstall },
    selectedMachineId: selection.machineId, selectedPaneId: selection.paneId,
  }), [machines, version, install.installed, install.canInstall, selection]);
  return <MachineSidebar model={model} tree={tree} emit={emit} />;
}
