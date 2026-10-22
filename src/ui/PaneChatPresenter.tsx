import { useCallback, useMemo } from "react";
import { paneStorageId } from "../../shared/machines.ts";
import type { FleetAgentKind } from "../../shared/fleet.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { answerHint } from "../lib/promptAnswer.ts";
import { t } from "../lib/i18n.ts";
import { RenderBoundary } from "../components/RenderBoundary.tsx";
import type { Emit } from "./bubble.ts";
import { ChatPresenter, type ChatUpEvent } from "./ChatPresenter.tsx";
import { ComposerPresenter, type ComposerUpEvent } from "./ComposerPresenter.tsx";
import type { ThreadRowModel } from "./fleetView.ts";
import { useSelected } from "./presenter.ts";
import { lensed, type Lens, type UiEvent } from "./state.ts";

/** fleet runs live on this PC */
const FLEET_MACHINE = "local";

export interface PaneChatPresenterProps {
  /** the fleet run whose pane this is: the stop button interrupts it */
  runId: string;
  paneId: string;
  agent: FleetAgentKind;
  ended: boolean;
  lens: Lens;
  /** a project conversation's threads, for their cards */
  threads?: ThreadRowModel[];
  autoFocus?: boolean;
  emit: Emit<UiEvent>;
}

/**
 * A fleet run's pane as a chat in the Fleet screen: its conversation, its waiting prompt and its
 * composer, on one of the state's two chats (the project conversation on the pane's, a thread or
 * an agent on the one beside). A message goes through the same socket the open pane's does.
 */
export function PaneChatPresenter({ runId, paneId, agent, ended, lens, threads, autoFocus = false, emit }: PaneChatPresenterProps) {
  const connected = useSelected((state) => state.pane.connected);
  const agentStatus = useSelected((state) => state.machines.list.find((machine) => machine.id === FLEET_MACHINE)?.snapshot?.panes.find((pane) => pane.pane_id === paneId)?.agent_status);
  const prompt = useSelected((state) => {
    const { chat } = lensed(state, lens);
    return chat.open?.paneId === paneId ? chat.prompt : null;
  });
  const pendingAnswer = useSelected((state) => {
    const { chat } = lensed(state, lens);
    return chat.open?.paneId === paneId ? chat.pendingAnswer : null;
  });
  const suggestion = useSelected((state) => {
    const { chat } = lensed(state, lens);
    return chat.open?.paneId === paneId ? chat.suggestion : null;
  });
  const metadata = useSelected((state) => {
    const { chat } = lensed(state, lens);
    return chat.metadata?.paneId === paneId ? chat.metadata.value : null;
  });
  // as in the pane's own composer, a prompt is answered from the box; a message to a working agent
  // goes in at once (the agent CLI queues it), as no held messages are listed here
  const answering = prompt !== null && !prompt.queued && !prompt.fallback ? prompt : null;
  const composerEmit = useCallback((event: ComposerUpEvent) => {
    if (event.type === "abort-turn") { emit({ type: "interrupt-run", runId }); return; }
    if (event.type !== "send-message") { emit(event); return; }
    emit({
      type: "composer-send", owner: paneStorageId(FLEET_MACHINE, paneId), machineId: FLEET_MACHINE, paneId, text: event.text, via: event.via,
      bracketedPaste: false, working: false, ...(lens === "main" ? {} : { lens }),
    });
  }, [emit, lens, paneId, runId]);
  const chatEmit = useMemo<Emit<ChatUpEvent>>(() => (event) => emit(event), [emit]);
  return (
    <MachineContext.Provider value={FLEET_MACHINE}>
      {/* a click anywhere in it gives it the focus (not the keyboard's tab order): the prompt steps go to the chat with the focus */}
      <div className="fleet-chat" data-chat-lens={lens} tabIndex={-1}>
        {/* the transcript lies over this box, as it lies over the terminal in the pane */}
        <div className="fleet-chat-surface">
        <RenderBoundary resetKey={paneId} fallback={(retry) => (
          <div className="chat-view"><div className="chat-empty" role="alert">
            <p>{t("The chat can't be shown. The terminal still works.")}</p>
            <button type="button" className="btn" onClick={retry}>{t("Try again")}</button>
          </div></div>
        )}>
          <ChatPresenter paneId={paneId} connected={connected} ended={ended} agent={agent} agentStatus={agentStatus} lens={lens} threads={threads} emit={chatEmit} />
        </RenderBoundary>
        </div>
        {!ended && (
          <ComposerPresenter
            key={paneId}
            paneId={paneId}
            autoFocus={autoFocus}
            agent={agent}
            agentStatus={agentStatus}
            metadata={metadata}
            connected={connected}
            queueMode={false}
            answerHint={answering === null ? null : pendingAnswer?.promptId === answering.id ? t("Confirm your answer in the card above, or type another…") : answerHint(answering)}
            suggestion={prompt === null ? suggestion : null}
            lens={lens}
            emit={composerEmit}
          />
        )}
      </div>
    </MachineContext.Provider>
  );
}
