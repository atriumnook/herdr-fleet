import type { KeyboardEvent, ReactNode } from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import type { SideChatSnapshot } from "../../shared/side-chat.ts";
import { t } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";

export type SideChatEvent =
  | { type: "side-chat-draft"; text: string }
  | { type: "side-chat-ask"; paneId: string; text: string }
  | { type: "side-chat-interrupt" }
  | { type: "side-chat-close" };

export interface SideChatModel {
  /** the pane the questions are about */
  paneId: string;
  /** the pane's side chat; null before its first question, or once closed */
  chat: SideChatSnapshot | null;
  /** the server said whether the pane has one */
  loaded: boolean;
  asking: boolean;
  error: string | null;
  draft: string;
  /** Enter sends (Shift+Enter breaks the line), as in the pane's own box; else Ctrl/⌘+Enter */
  enterSends: boolean;
}

export interface SideChatProps {
  model: SideChatModel;
  /** the side chat's conversation, drawn as the pane's chat draws its own */
  conversation: ReactNode;
  emit: Emit<SideChatEvent>;
}

/**
 * The side chat: questions asked beside the pane's conversation and answered apart from it. It
 * opens with a box for the first question; once asked, its conversation shows above the box, which
 * stops the answer under way, and a new side chat starts over from the conversation as it is then.
 */
export function SideChat({ model, conversation, emit }: SideChatProps) {
  const { paneId, chat, loaded, asking, error, draft, enterSends } = model;
  const working = chat?.status === "working";
  const ended = chat?.status === "ended";
  const send = () => {
    if (draft.trim() && !asking) emit({ type: "side-chat-ask", paneId, text: draft });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // an IME keeps its keys; WebKit can send the committing Enter after compositionend, as key code 229
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key !== "Enter") return;
    const chord = event.metaKey || event.ctrlKey;
    if (enterSends ? event.shiftKey || event.altKey : !chord) return;
    event.preventDefault();
    send();
  };
  return (
    <div className="side-chat">
      {chat !== null && (
        <div className="side-chat-bar">
          <span className="side-chat-source">
            {chat.source === "fork" ? t("Knows this Claude session up to when it opened.") : t("Read this pane's conversation when it opened.")}
          </span>
          <button type="button" className="btn btn-ghost side-chat-new" onClick={() => emit({ type: "side-chat-close" })} title={t("Ends this side chat; nothing of it is kept.")}>
            <Plus aria-hidden="true" /><span>{t("New side chat")}</span>
          </button>
        </div>
      )}
      <div className="side-chat-body">
        {chat !== null ? conversation : (
          <div className="side-panel-start">
            <p>{t("Ask about this conversation without interrupting it. The answer changes nothing, and nothing of it goes back into the conversation.")}</p>
            {!loaded && <p>{t("Loading…")}</p>}
          </div>
        )}
      </div>
      {ended && <p className="side-chat-note" role="status">{t("This side chat has ended. A question starts a new one.")}</p>}
      {(error ?? chat?.error) && <p className="side-panel-error side-chat-note" role="alert">{error ?? chat?.error}</p>}
      <div className="composer-box side-chat-box">
        <textarea rows={2} value={draft} placeholder={t("Ask on the side")} aria-label={t("Ask on the side")} spellCheck={false}
          onChange={(event) => emit({ type: "side-chat-draft", text: event.target.value })} onKeyDown={onKeyDown} />
        {working
          ? <button type="button" className="icon-button side-chat-send" aria-label={t("Stop")} title={t("Stop")} onClick={() => emit({ type: "side-chat-interrupt" })}><Square aria-hidden="true" /></button>
          : <button type="button" className="icon-button side-chat-send is-primary" aria-label={t("Ask")} title={t("Ask")} disabled={asking || !draft.trim()} onClick={send}><ArrowUp aria-hidden="true" /></button>}
      </div>
    </div>
  );
}
