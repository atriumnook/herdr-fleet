import { useMemo } from "react";
import { PaneTerminal } from "../components/PaneTerminal.tsx";
import { SidePanel } from "../components/SidePanel.tsx";
import { useSettings } from "../lib/settings.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import type { Emit } from "./bubble.ts";
import { PaneChatPresenter } from "./PaneChatPresenter.tsx";
import { useRegions, useSelected } from "./presenter.ts";
import { SIDE_PANEL_REGIONS, sidePanelModel } from "./sidePanelView.ts";
import type { UiEvent } from "./state.ts";

/**
 * The side panel's Presenter, on both screens: what it is about and what it has open, read from the
 * selection, the Fleet screen's front pane, the runs and the session tree. The side chat is a
 * fleet run's chat on the `side-chat` lens, the terminal a second grid on the `side-terminal` lens,
 * through the open pane's socket.
 */
export function SidePanelPresenter({ emit }: { emit: Emit<UiEvent> }) {
  const source = useRegions(...SIDE_PANEL_REGIONS);
  const model = useMemo(() => sidePanelModel(source), [source]);
  const { settings, resolvedTheme } = useSettings();
  const role = useSelected((state) => state.pane.role);
  // a side chat that stopped is not open: the panel asks for a new one
  const chat = model.open && model.chat.kind === "open"
    ? <PaneChatPresenter key={model.chat.paneId} runId={model.chat.runId} paneId={model.chat.paneId} agent={model.chat.agent} ended={false} lens="side-chat" emit={emit} />
    : null;
  const terminal = model.open && model.terminal.kind === "open" && model.about
    ? (
      <MachineContext.Provider value={model.about.machineId}>
        <PaneTerminal key={model.terminal.paneId} paneId={model.terminal.paneId} view="terminal" chatShown={false}
          terminalFontSize={settings.terminalFontSize} terminalWheelSpeed={settings.terminalWheelSpeed} terminalFontFamily={settings.terminalFontFamily}
          theme={resolvedTheme} role={role} lens="side-terminal" emit={emit} />
      </MachineContext.Provider>
    )
    : null;
  return <SidePanel model={model} chat={chat} terminal={terminal} emit={emit} />;
}
