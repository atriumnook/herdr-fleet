import { useEffect, useMemo, useRef } from "react";
import type { AgentStatus, ConversationTurn } from "../../shared/protocol.ts";
import { ChatView, type ChatViewEvent, type ChatViewModel } from "../components/ChatView.tsx";
import { useMachineId } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import type { Emit } from "./bubble.ts";
import { EMPTY_VIEW, type UiEvent, type UiState } from "./state.ts";
import { useSelected } from "./presenter.ts";

export type ChatUpEvent = ChatViewEvent | Extract<UiEvent, { type: "chat-open" | "chat-close" | "chat-agent" }>;

/** no earlier turns: the same empty list each render, for the view's memo */
const NO_TURNS: ConversationTurn[] = [];

export interface ChatPresenterProps {
  paneId: string;
  connected: boolean;
  ended: boolean;
  agent: string | null;
  agentStatus: AgentStatus | undefined;
  emit: Emit<ChatUpEvent>;
}

/**
 * The chat lens's Presenter, inside the pane's terminal (not yet migrated): the conversation
 * and the prompt the Mediator reads for this pane, each part read apart so a poll that changed
 * one re-renders for it alone. It says the chat is open on the pane while it is mounted (a new
 * Codex TUI can show its directory-trust menu while herdr still reports idle, so the visible
 * prompt, not the status badge, decides whether to offer answers), and whether it has an agent.
 */
export function ChatPresenter({ paneId, connected, ended, agent, agentStatus, emit }: ChatPresenterProps) {
  const machineId = useMachineId();
  const emitRef = useRef(emit);
  emitRef.current = emit;
  useEffect(() => {
    emitRef.current({ type: "chat-open", machineId, paneId });
    return () => emitRef.current({ type: "chat-close", machineId, paneId });
  }, [machineId, paneId]);
  const hasAgent = agent !== null;
  useEffect(() => emitRef.current({ type: "chat-agent", paneId, agent: hasAgent }), [paneId, hasAgent]);

  const here = (state: UiState): boolean => state.conversation.open?.paneId === paneId;
  const view = useSelected((state) => (here(state) ? state.conversation.view : EMPTY_VIEW));
  const fresh = useSelected((state) => !here(state) || state.conversation.fresh);
  const older = useSelected((state) => (here(state) ? state.conversation.older.turns : NO_TURNS));
  const olderCursor = useSelected((state) => (here(state) ? state.conversation.older.cursor : undefined));
  const olderState = useSelected((state) => (here(state) ? state.conversation.older.status : "idle"));
  const historyId = useSelected((state) => (here(state) ? state.conversation.historyId : undefined));
  const error = useSelected((state) => (here(state) ? state.conversation.error : null));
  const loaded = useSelected((state) => here(state) && state.conversation.loaded);
  const abandoned = useSelected((state) => (here(state) ? state.conversation.abandoned : null));
  const sentOver = useSelected((state) => (here(state) ? state.conversation.sentOver : null));
  const prompt = useSelected((state) => (state.chat.open?.paneId === paneId ? state.chat.prompt : null));
  const pendingAnswer = useSelected((state) => (state.chat.open?.paneId === paneId ? state.chat.pendingAnswer : null));
  const { settings: { showThinking } } = useSettings();
  const model = useMemo<ChatViewModel>(() => ({
    paneId, connected, ended, agent, agentStatus, view, fresh, older, olderCursor, olderState, historyId, error, loaded, abandoned, sentOver, prompt, pendingAnswer, showThinking,
  }), [paneId, connected, ended, agent, agentStatus, view, fresh, older, olderCursor, olderState, historyId, error, loaded, abandoned, sentOver, prompt, pendingAnswer, showThinking]);
  return <ChatView model={model} emit={emit} />;
}
