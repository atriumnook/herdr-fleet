import { useMemo } from "react";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { CommandPalette, type CommandPaletteEvent, type CommandPaletteModel } from "../components/CommandPalette.tsx";
import type { PaneView } from "../lib/actions.ts";
import type { Emit } from "./bubble.ts";
import { useSelected } from "./presenter.ts";

export interface CommandPalettePresenterProps {
  /** the selected pane's PC's sessions, as the shell keeps them */
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  view: PaneView;
  offers: CommandPaletteModel["offers"];
  emit: Emit<CommandPaletteEvent>;
}

/** The palette's Presenter: its region from the Mediator, the sessions and the actions on offer from the shell. Draws nothing while closed. */
export function CommandPalettePresenter({ snapshot, selectedPaneId, view, offers, emit }: CommandPalettePresenterProps) {
  const palette = useSelected((state) => state.palette);
  const model = useMemo<CommandPaletteModel | null>(() => (palette.open
    ? { snapshot, selectedPaneId, view, query: palette.query, recent: palette.recent, offers }
    : null), [palette, snapshot, selectedPaneId, view, offers.notifications, offers.lock, offers.files]); // eslint-disable-line react-hooks/exhaustive-deps
  return model === null ? null : <CommandPalette model={model} emit={emit} />;
}
