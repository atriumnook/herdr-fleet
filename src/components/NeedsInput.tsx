import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { t } from "../lib/i18n.ts";
import { panesNeedingInput } from "../lib/needsInput.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import type { Emit } from "../ui/bubble.ts";
import "./NeedsInput.css";

export type NeedsInputEvent = { type: "select-pane"; machineId: string; paneId: string };

/** The panes waiting on the person, on every PC, above the PCs' own trees. */
export function NeedsInput({ machines, selectedMachineId, selectedPaneId, emit }: {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  emit: Emit<NeedsInputEvent>;
}) {
  const waiting = panesNeedingInput(machines);
  return <>
    <p className="visually-hidden" role="status">{t("Panes that need you: {n}", { n: waiting.length })}</p>
    {waiting.length > 0 && <section className="needs-input" aria-label={t("Needs you")}>
    <h2 className="needs-input-heading">{t("Needs you")} <span className="pill">{waiting.length}</span></h2>
    <ul className="pane-list">
      {waiting.map(({ machine, pane, workspace }) => {
        const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
        return <li className={`needs-input-item${selected ? " is-selected" : ""}`} key={paneStorageId(machine.id, pane.pane_id)}>
          <button type="button" className="pane-select needs-input-select" aria-current={selected ? "true" : undefined} onClick={() => emit({ type: "select-pane", machineId: machine.id, paneId: pane.pane_id })}>
            <span className="agent-mark-holder"><AgentMark agent={pane.agent ?? ""} size={18} /></span>
            <span className="pane-copy">
              <span className="pane-title">{displayPaneTitle(pane)}</span>
              <span className="pane-subtitle">{machine.name} · {workspace.label}</span>
            </span>
            <StatusBadge status={pane.agent_status} dot />
          </button>
        </li>;
      })}
    </ul>
    </section>}
  </>;
}
