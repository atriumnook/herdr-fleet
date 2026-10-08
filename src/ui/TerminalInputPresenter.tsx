import { useLayoutEffect, useRef } from "react";
import { TerminalInput, type TerminalInputEvent } from "../components/TerminalInput.tsx";
import type { Emit } from "./bubble.ts";
import { useSelected } from "./presenter.ts";

export interface TerminalInputPresenterProps {
  /** the pane's storage id */
  owner: string;
  connected: boolean;
  onComposing: (active: boolean) => void;
  /** an empty line's send: Enter alone, as the terminal sends a keystroke */
  onEnter: () => boolean;
  emit: Emit<TerminalInputEvent>;
}

/** The terminal input line's Presenter, inside the pane's terminal (not yet migrated): the pane's line as the Mediator keeps it, read back as it opens. */
export function TerminalInputPresenter({ owner, connected, onComposing, onEnter, emit }: TerminalInputPresenterProps) {
  const emitRef = useRef(emit);
  emitRef.current = emit;
  useLayoutEffect(() => emitRef.current({ type: "line-draft", owner, change: { kind: "read" } }), [owner]);
  const line = useSelected((state) => state.drafts.line[owner]);
  const outcome = useSelected((state) => state.sends.outcomes[`line:${owner}`]);
  return <TerminalInput model={{ owner, connected, text: line?.text ?? "", sending: line?.sending ?? false, outcome }} onComposing={onComposing} onEnter={onEnter} emit={emit} />;
}
