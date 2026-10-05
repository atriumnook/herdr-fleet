import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Download, Monitor, Plus, Settings } from "lucide-react";
import type { Machine, MachineState } from "../../shared/machines.ts";
import type { Emit } from "../ui/bubble.ts";
import { NeedsInput, type NeedsInputEvent } from "./NeedsInput.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";

declare const __APP_VERSION__: string;

/** The PC header's state word; "connected" is the quiet default and shows as a dot alone. */
export const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Connection error",
};

/** What the sidebar sends up: a pane picked, the Settings dialog for the Mediator; a new session and the install prompt for the shell. */
export type MachineSidebarEvent =
  | NeedsInputEvent
  | { type: "open-settings" }
  | { type: "new-session"; machineId: string }
  | { type: "install-app" };

export interface MachineSidebarModel {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  /** herdr's version on this PC */
  version: string | null;
  install: { installed: boolean; canInstall: boolean; help: string };
}

interface Props {
  model: MachineSidebarModel;
  /** a connected PC's sessions, drawn by the shell */
  tree: (machine: Machine) => ReactNode;
  emit: Emit<MachineSidebarEvent>;
}

export function MachineSidebar(props: Props) {
  const t = useT();
  const { machines, selectedMachineId, selectedPaneId, version, install: { canInstall, installed, help } } = props.model;
  const emit = props.emit;
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  // no top bar: a session starts from its PC's header
  return <div className="sidebar-shell">
    <div className="machine-list" aria-label={t("PCs and workspaces")}>
      <NeedsInput machines={machines} selectedMachineId={selectedMachineId} selectedPaneId={selectedPaneId} emit={emit} />
      {machines.map((machine) => <MachineGroup key={machine.id} machine={machine} current={selectedMachineId === machine.id} tree={props.tree} emit={emit} />)}
      {!machines.length && <p className="tree-state" role="status">{t("Loading PCs…")}</p>}
    </div>
    <footer className="sidebar-footer">
      {/* browsers without an install prompt (iOS, plain HTTP) get the steps instead */}
      {!installed && <button className="btn btn-ghost sidebar-footer-action" aria-expanded={canInstall ? undefined : installHelpOpen} onClick={() => { if (canInstall) emit({ type: "install-app" }); else setInstallHelpOpen(!installHelpOpen); }}><Download aria-hidden="true" />{t("Install app")}</button>}
      {!installed && !canInstall && installHelpOpen && <p className="sidebar-install-help" role="status">{help}</p>}
      <div className="sidebar-footer-row">
        <button className="btn btn-ghost sidebar-footer-action" title={t("Settings (⌘⇧,)")} onClick={() => emit({ type: "open-settings" })}><Settings aria-hidden="true" />{t("Settings")}</button>
      </div>
      <div className="sidebar-brandline">
        <span className="sidebar-app-name">herdr fleet v{__APP_VERSION__}</span>
        {version && <span className="pill">herdr {version}</span>}
      </div>
    </footer>
  </div>;
}

/** One PC: its header, its state when not connected, and its sessions. Folding it is the view's own, kept per PC. */
function MachineGroup({ machine, current, tree, emit }: { machine: Machine; current: boolean; tree: Props["tree"]; emit: Emit<MachineSidebarEvent> }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(`herdr-fleet:pc-collapsed:${machine.id}`) === "1"; } catch { return false; } });
  const online = machine.state === "connected";
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem(`herdr-fleet:pc-collapsed:${machine.id}`, collapsed ? "0" : "1"); } catch {}
  };
  return <section className={`machine-group${current ? " is-current" : ""}`} aria-label={t("PC {name}", { name: machine.name })}>
    <header className="machine-header">
      <button className="machine-toggle" aria-expanded={!collapsed} onClick={toggle}>
        {collapsed ? <ChevronRight className="machine-caret" aria-hidden="true" /> : <ChevronDown className="machine-caret" aria-hidden="true" />}
        <Monitor className="machine-icon" aria-hidden="true" />
        <span className="machine-name">{machine.name}</span>
        {/* the computer this app's server runs on; on a phone "this PC" read as the phone */}
        {machine.kind === "local" && <span className="machine-kind" title={t("The computer this app runs on")}>{t("Host")}</span>}
        <span className={`machine-dot is-${machine.state}`} title={t(STATE_WORD[machine.state])} aria-hidden="true" />
      </button>
      <button className="sidebar-row-action" disabled={!online} aria-label={t("New session on {name}", { name: machine.name })} title={t("New session")} onClick={() => emit({ type: "new-session", machineId: machine.id })}><Plus aria-hidden="true" /></button>
    </header>
    {/* connected is the norm and says nothing new; every other state is spelled out */}
    <p className={`machine-state is-${machine.state}${online ? " visually-hidden" : ""}`} role="status" title={machine.error ?? undefined}>
      <span className="machine-state-word">{STATE_WORD[machine.state]}</span>
      {machine.error && <span className="machine-state-detail">{machine.error}</span>}
    </p>
    {!collapsed && <div className={online ? "" : "machine-offline"} {...(!online ? { inert: "" } : {})}>
      {!online && !machine.snapshot ? <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p> : tree(machine)}
    </div>}
  </section>;
}
