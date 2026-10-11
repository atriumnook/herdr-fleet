import { useEffect, useMemo, useRef } from "react";
import type { AgentStatus, ConversationTurn } from "../../shared/protocol.ts";
import { ChatView, type ChatViewEvent, type ChatViewModel } from "../components/ChatView.tsx";
import { useMachineId } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { relay, type Emit } from "./bubble.ts";
import { EMPTY_VIEW, type Lens, type UiEvent, type UiState } from "./state.ts";
import { threadCards, type ThreadRowModel } from "./fleetView.ts";
import { useSelected } from "./presenter.ts";

export type ChatUpEvent = Exclude<ChatViewEvent, { type: "card-answer" }> | Extract<UiEvent, { type: "chat-open" | "chat-close" | "chat-agent" | "prompt-card-answer" }>;

/** no threads: the same empty list each render */
const NO_THREADS: ThreadRowModel[] = [];

/** no earlier turns: the same empty list each render, for the view's memo */
const NO_TURNS: ConversationTurn[] = [];

export interface ChatPresenterProps {
  paneId: string;
  connected: boolean;
  ended: boolean;
  agent: string | null;
  agentStatus: AgentStatus | undefined;
  /** which of the state's chats this one is: the pane's (default) or the one beside */
  lens?: Lens;
  /** a project conversation's threads: each one's card goes under the coordinator's turn that started it */
  threads?: ThreadRowModel[];
  emit: Emit<ChatUpEvent>;
}

/**
 * The chat lens's Presenter, inside the pane's terminal (not yet migrated): the conversation
 * and the prompt the Mediator reads for this pane, each part read apart so a poll that changed
 * one re-renders for it alone. It says the chat is open on the pane while it is mounted (a new
 * Codex TUI can show its directory-trust menu while herdr still reports idle, so the visible
 * prompt, not the status badge, decides whether to offer answers), and whether it has an agent.
 */
export function ChatPresenter({ paneId, connected, ended, agent, agentStatus, lens = "main", threads = NO_THREADS, emit: up }: ChatPresenterProps) {
  const machineId = useMachineId();
  // what this chat says goes to its own chat in the state
  const emit = useMemo<Emit<ChatUpEvent>>(() => (lens === "side" ? (event) => up({ ...event, lens: "side" }) : up), [lens, up]);
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const lensOf = (state: UiState) => (lens === "side" ? state.side : state);
  useEffect(() => {
    emitRef.current({ type: "chat-open", machineId, paneId });
    return () => emitRef.current({ type: "chat-close", machineId, paneId });
  }, [machineId, paneId]);
  const hasAgent = agent !== null;
  useEffect(() => emitRef.current({ type: "chat-agent", paneId, agent: hasAgent }), [paneId, hasAgent]);

  const here = (state: UiState): boolean => lensOf(state).conversation.open?.paneId === paneId;
  const view = useSelected((state) => (here(state) ? lensOf(state).conversation.view : EMPTY_VIEW));
  const fresh = useSelected((state) => !here(state) || lensOf(state).conversation.fresh);
  const older = useSelected((state) => (here(state) ? lensOf(state).conversation.older.turns : NO_TURNS));
  const olderCursor = useSelected((state) => (here(state) ? lensOf(state).conversation.older.cursor : undefined));
  const olderState = useSelected((state) => (here(state) ? lensOf(state).conversation.older.status : "idle"));
  const historyId = useSelected((state) => (here(state) ? lensOf(state).conversation.historyId : undefined));
  const error = useSelected((state) => (here(state) ? lensOf(state).conversation.error : null));
  const loaded = useSelected((state) => here(state) && lensOf(state).conversation.loaded);
  const abandoned = useSelected((state) => (here(state) ? lensOf(state).conversation.abandoned : null));
  const sentOver = useSelected((state) => (here(state) ? lensOf(state).conversation.sentOver : null));
  const prompt = useSelected((state) => (lensOf(state).chat.open?.paneId === paneId ? lensOf(state).chat.prompt : null));
  const pendingAnswer = useSelected((state) => (lensOf(state).chat.open?.paneId === paneId ? lensOf(state).chat.pendingAnswer : null));
  const card = useSelected((state) => (lensOf(state).chat.open?.paneId === paneId ? lensOf(state).chat.card : null));
  const seek = useSelected((state) => (lensOf(state).chat.open?.paneId === paneId ? lensOf(state).chat.seek : null));
  const { settings: { showThinking } } = useSettings();
  const cards = useMemo(() => (threads.length === 0 ? undefined : threadCards([...older, ...view.turns], threads)), [threads, older, view.turns]);
  const model = useMemo<ChatViewModel>(() => ({
    paneId, connected, ended, agent, agentStatus, view, fresh, older, olderCursor, olderState, historyId, error, loaded, abandoned, sentOver, prompt, pendingAnswer, card, showThinking, cards, seek,
  }), [paneId, connected, ended, agent, agentStatus, view, fresh, older, olderCursor, olderState, historyId, error, loaded, abandoned, sentOver, prompt, pendingAnswer, card, showThinking, cards, seek]);
  // an answer in the prompt's card is for this pane's prompt on this PC
  const promptId = prompt?.id ?? null;
  const relayed = useMemo(() => relay<ChatViewEvent, ChatUpEvent>(emit, (event, pass) => {
    if (event.type !== "card-answer") pass(event);
    else if (promptId !== null) pass({ type: "prompt-card-answer", machineId, paneId, promptId, answer: event.answer, typed: event.typed });
  }), [emit, machineId, paneId, promptId]);
  return <ChatView model={model} emit={relayed} />;
}
