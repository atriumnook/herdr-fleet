import { useMemo } from "react";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { Sidebar, type SidebarEvent, type SidebarModel } from "../components/Sidebar.tsx";
import type { Emit } from "./bubble.ts";
import { useSelected } from "./presenter.ts";
import { treeOf, type ShownOrder } from "./state.ts";

/** The order a PC's workspaces are drawn in: a reorder shown while herdr's order is still what it was made on. */
export function shownOrder(snapshot: SessionSnapshot | null, order: ShownOrder | null): string[] {
  const herdr = snapshot?.workspaces.map((workspace) => workspace.workspace_id) ?? [];
  return order !== null && order.basis.join("\u0000") === herdr.join("\u0000") ? order.order : herdr;
}

/** A PC's session tree: its sessions from the shell, its tree region and the grouping from the Mediator. */
export function SidebarPresenter({ machineId, snapshot, selectedPaneId, emit }: { machineId: string; snapshot: SessionSnapshot | null; selectedPaneId: string | null; emit: Emit<SidebarEvent> }) {
  const tree = useSelected((state) => treeOf(state, machineId));
  const grouping = useSelected((state) => state.settings.sidebarGrouping);
  const model = useMemo<SidebarModel>(() => ({
    machineId, snapshot, selectedPaneId, grouping, tree, workspaceOrder: shownOrder(snapshot, tree.order),
  }), [machineId, snapshot, selectedPaneId, grouping, tree]);
  return <Sidebar model={model} emit={emit} />;
}
