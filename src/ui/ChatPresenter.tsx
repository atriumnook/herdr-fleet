import { useEffect, useMemo, useRef } from "react";
import type { AgentStatus, ConversationTurn, ExplainRequest, InteractivePrompt } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { endingQuestion, lastInstruction } from "../lib/plainQuestion.ts";
import { ChatView, type ChatViewEvent, type ChatViewModel } from "../components/ChatView.tsx";
import { useMachineId } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { relay, type Emit } from "./bubble.ts";
import { EMPTY_VIEW, type Explanation, type Lens, type UiEvent, type UiState } from "./state.ts";
import { threadCards, type ThreadRowModel } from "./fleetView.ts";
import { useSelected } from "./presenter.ts";

export type ChatUpEvent = Exclude<ChatViewEvent, { type: "card-answer" | "card-explain" | "asked-explain" | "asked-pick" }>
  | Extract<UiEvent, { type: "chat-open" | "chat-close" | "chat-agent" | "prompt-card-answer" | "explain-question" | "composer-draft" }>;

/** no explanations asked yet: the same empty record each render */
const NO_EXPLANATIONS: Readonly<Record<string, Explanation>> = {};

/** The question screen's question as one text: its heading, its question and the detail under them. */
function screenRequest(prompt: InteractivePrompt): Omit<ExplainRequest, "pane_id"> {
  const question = [...new Set([prompt.title, prompt.question])].join("\n") + (prompt.body ? `\n\n${prompt.body}` : "");
  return { kind: "screen", question, options: prompt.options.filter((_, index) => index !== prompt.custom_option_index).map(({ label, description }) => ({ label, description })) };
}

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
  const explanations = useSelected((state) => (lensOf(state).chat.open?.paneId === paneId ? lensOf(state).chat.explanations : NO_EXPLANATIONS));
  const { settings: { showThinking } } = useSettings();
  const cards = useMemo(() => (threads.length === 0 ? undefined : threadCards([...older, ...view.turns], threads)), [threads, older, view.turns]);
  const working = agentStatus === "working" || agentStatus === "blocked";
  // a question written at the end of a reply, found by a guess: offered here only, never counted as the pane needing the person
  const asked = useMemo(() => (view.source === "conversation" ? endingQuestion(view.turns, working) : null), [view, working]);
  const lastTurn = view.turns[view.turns.length - 1];
  const askedKey = asked === null ? null : `plain:${lastTurn?.ts ?? ""}:${asked.question}`;
  const promptKey = prompt === null ? null : `screen:${prompt.id}`;
  const instruction = useMemo(() => (prompt === null ? null : lastInstruction([...older, ...view.turns])), [prompt, older, view.turns]);
  const promptExplanation = promptKey === null ? undefined : explanations[promptKey];
  const askedExplanation = askedKey === null ? undefined : explanations[askedKey];
  const model = useMemo<ChatViewModel>(() => ({
    paneId, connected, ended, agent, agentStatus, view, fresh, older, olderCursor, olderState, historyId, error, loaded, abandoned, sentOver, prompt, pendingAnswer, card, showThinking, cards, seek,
    instruction, asked, promptExplanation, askedExplanation,
  }), [paneId, connected, ended, agent, agentStatus, view, fresh, older, olderCursor, olderState, historyId, error, loaded, abandoned, sentOver, prompt, pendingAnswer, card, showThinking, cards, seek, instruction, asked, promptExplanation, askedExplanation]);
  // an answer in the prompt's card is for this pane's prompt on this PC
  const relayed = useMemo(() => relay<ChatViewEvent, ChatUpEvent>(emit, (event, pass) => {
    switch (event.type) {
      case "card-answer":
        if (prompt !== null) pass({ type: "prompt-card-answer", machineId, paneId, promptId: prompt.id, answer: event.answer, typed: event.typed });
        return;
      case "card-explain":
        if (prompt !== null && promptKey !== null) pass({ type: "explain-question", machineId, paneId, key: promptKey, request: screenRequest(prompt) });
        return;
      case "asked-explain":
        if (asked !== null && askedKey !== null) pass({ type: "explain-question", machineId, paneId, key: askedKey, request: { kind: "plain", question: asked.question, options: asked.options } });
        return;
      case "asked-pick": {
        // the choice goes into this pane's message box; the person sends it
        const option = asked?.options[event.index];
        if (option !== undefined) pass({ type: "composer-draft", owner: paneStorageId(machineId, paneId), change: { kind: "set", text: `${event.index + 1}. ${option.label}` } });
        return;
      }
      default:
        pass(event);
    }
  }), [emit, machineId, paneId, prompt, promptKey, asked, askedKey]);
  return <ChatView model={model} emit={relayed} />;
}
