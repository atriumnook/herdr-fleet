import { useEffect, useMemo } from "react";
import { PaneTerminal } from "../components/PaneTerminal.tsx";
import { SidePanel } from "../components/SidePanel.tsx";
import { useSettings } from "../lib/settings.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import type { Emit } from "./bubble.ts";
import { SideChatPresenter } from "./SideChatPresenter.tsx";
import { useRegions, useSelected } from "./presenter.ts";
import { SIDE_PANEL_REGIONS, sidePanelModel } from "./sidePanelView.ts";
import type { UiEvent } from "./state.ts";

/**
 * The side panel's Presenter, on both screens: what it is about and what it has open, read from the
 * selection, the Fleet screen's front pane and the session tree. While it shows, the state reads the
 * side chat of the pane it is about from the server; a terminal tab with no terminal opens one, as
 * a desktop app's terminal pane does. The terminal is a second grid on the `side-terminal` lens,
 * through the open pane's socket.
 */
export function SidePanelPresenter({ emit }: { emit: Emit<UiEvent> }) {
  const source = useRegions(...SIDE_PANEL_REGIONS);
  const model = useMemo(() => sidePanelModel(source), [source]);
  const { settings, resolvedTheme } = useSettings();
  const role = useSelected((state) => state.pane.role);
  const { about, terminals } = model;

  const watched = model.open && model.chatHere && about !== null ? about.paneId : null;
  useEffect(() => { emit({ type: "side-chat-watch", paneId: watched }); }, [emit, watched]);

  const wantsTerminal = model.open && model.tab === "terminal" && about !== null && terminals.list.length === 0 && !terminals.opening && terminals.failed === null;
  useEffect(() => {
    if (wantsTerminal && about !== null) emit({ type: "open-side-terminal", machineId: about.machineId, paneId: about.paneId });
  }, [emit, wantsTerminal, about]);

  const chat = model.open && model.chatHere && about !== null ? <SideChatPresenter key={about.paneId} paneId={about.paneId} emit={emit} /> : null;
  const terminal = model.open && about !== null && terminals.shown !== null && !terminals.inPane
    ? (
      <MachineContext.Provider value={about.machineId}>
        <PaneTerminal key={terminals.shown} paneId={terminals.shown} view="terminal" chatShown={false}
          terminalFontSize={settings.terminalFontSize} terminalWheelSpeed={settings.terminalWheelSpeed} terminalFontFamily={settings.terminalFontFamily}
          theme={resolvedTheme} role={role} lens="side-terminal" emit={emit} />
      </MachineContext.Provider>
    )
    : null;
  return <SidePanel model={model} chat={chat} terminal={terminal} emit={emit} />;
}
