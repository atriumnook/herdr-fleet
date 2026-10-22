import { useCallback, useMemo } from "react";
import { ChatView, type ChatViewEvent, type ChatViewModel } from "../components/ChatView.tsx";
import { SideChat, type SideChatEvent } from "../components/SideChat.tsx";
import { fileUrl } from "../lib/api.ts";
import { FileUrlContext, OpenFileContext } from "../lib/filePaths.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import type { Emit } from "./bubble.ts";
import { useSelected } from "./presenter.ts";
import { sideChatTurns } from "./sidePanelView.ts";
import type { UiEvent } from "./state.ts";

/** side chats run on this PC's server, about its panes */
const SIDE_CHAT_MACHINE = "local";

/**
 * The side panel's side chat about a pane: the server's side chat as the state last read it, drawn
 * by the chat the panes use, with its own box. A path in it is read from the pane's folder, where
 * the side chat runs.
 */
export function SideChatPresenter({ paneId, emit }: { paneId: string; emit: Emit<UiEvent> }) {
  const side = useSelected((state) => state.sidePanel.chat);
  const { settings: { showThinking, enterSends } } = useSettings();
  const chat = side.paneId === paneId ? side.chat : null;
  const turns = useMemo(() => (chat === null ? [] : sideChatTurns(chat)), [chat]);
  const model = useMemo<ChatViewModel | null>(() => (chat === null ? null : {
    paneId, connected: true, ended: chat.status === "ended", agent: "claude", agentStatus: chat.status === "working" ? "working" : "idle",
    view: { source: "conversation", turns, messages: [], truncated: false }, fresh: chat.turns.length === 0,
    older: [], olderCursor: null, olderState: "idle", historyId: chat.id, error: null, loaded: true, abandoned: null, sentOver: null,
    prompt: null, pendingAnswer: null, card: null, showThinking, seek: null,
  }), [chat, paneId, turns, showThinking]);
  // the chat's only ask that means something here: go to a pane a message names
  const chatEmit = useCallback<Emit<ChatViewEvent>>((event) => { if (event.type === "go-to-pane") emit(event); }, [emit]);
  const openFile = useCallback((path: string) => emit({ type: "open-file", path, pane: { machineId: SIDE_CHAT_MACHINE, paneId } }), [emit, paneId]);
  const urlOf = useCallback((path: string) => fileUrl(path, paneId, SIDE_CHAT_MACHINE), [paneId]);
  const conversation = model === null ? null : (
    <MachineContext.Provider value={SIDE_CHAT_MACHINE}>
      <OpenFileContext.Provider value={openFile}><FileUrlContext.Provider value={urlOf}>
        <ChatView model={model} emit={chatEmit} />
      </FileUrlContext.Provider></OpenFileContext.Provider>
    </MachineContext.Provider>
  );
  const sideEmit = useCallback<Emit<SideChatEvent>>((event) => emit(event), [emit]);
  return (
    <SideChat
      model={{ paneId, chat, loaded: side.paneId === paneId && side.loaded, asking: side.asking, error: side.paneId === paneId ? side.error : null, draft: side.drafts[paneId] ?? "", enterSends }}
      conversation={conversation} emit={sideEmit} />
  );
}
