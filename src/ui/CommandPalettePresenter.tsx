import { useMemo } from "react";
import type { ConversationTurn, SessionSnapshot } from "../../shared/protocol.ts";
import { CommandPalette, type CommandPaletteEvent, type CommandPaletteModel } from "../components/CommandPalette.tsx";
import type { PaneView } from "../lib/actions.ts";
import { findPrompts, railEntries, type RailEntry } from "../lib/promptRail.ts";
import type { Emit } from "./bubble.ts";
import { lensed, type UiState } from "./state.ts";
import { useSelected } from "./presenter.ts";

export interface CommandPalettePresenterProps {
  /** the selected pane's PC's sessions, as the shell keeps them */
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  view: PaneView;
  offers: CommandPaletteModel["offers"];
  emit: Emit<CommandPaletteEvent>;
}

/** no turns, no prompts: the same empty lists each render */
const NO_TURNS: ConversationTurn[] = [];
const NO_PROMPTS: RailEntry[] = [];
/** the prompts the palette lists at most */
const PROMPT_LIMIT = 5;

/**
 * The palette's Presenter: its region from the Mediator, the sessions and the actions on offer
 * from the shell, and the open chat's prompts that hold the words searched for (the turns it has
 * read, as its rail lists them). Draws nothing while closed.
 */
export function CommandPalettePresenter({ snapshot, selectedPaneId, view, offers, emit }: CommandPalettePresenterProps) {
  const palette = useSelected((state) => state.palette);
  // the searched chat's turns, read from the state alone (a value from outside a selector would be
  // kept with its answer): the pane's chat or the one beside, and none while the palette is closed
  const conversationOf = (state: UiState) => (!state.palette.open ? null : lensed(state, state.palette.chat).conversation);
  const older = useSelected((state) => {
    const conversation = conversationOf(state);
    return conversation?.open ? conversation.older.turns : NO_TURNS;
  });
  const newest = useSelected((state) => {
    const conversation = conversationOf(state);
    return conversation?.open && conversation.view.source === "conversation" ? conversation.view.turns : NO_TURNS;
  });
  const query = palette.open ? palette.query : "";
  // the chat's prompts while it shows: a pick scrolls it
  const prompts = useMemo(() => (offers.prompts && query.trim().length > 0 ? findPrompts(railEntries([...older, ...newest]), query).slice(0, PROMPT_LIMIT) : NO_PROMPTS), [older, newest, query, offers.prompts]);
  const model = useMemo<CommandPaletteModel | null>(() => (palette.open
    ? { snapshot, selectedPaneId, view, query: palette.query, recent: palette.recent, offers, prompts }
    : null), [palette, snapshot, selectedPaneId, view, offers.notifications, offers.lock, offers.files, prompts]); // eslint-disable-line react-hooks/exhaustive-deps
  return model === null ? null : <CommandPalette model={model} emit={emit} />;
}
