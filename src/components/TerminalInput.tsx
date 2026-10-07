import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, SendHorizontal } from "lucide-react";

import "./TerminalInput.css";
import { TERMINAL_LINE_LIMIT } from "../lib/terminalDraft.ts";
import { submitNote } from "../lib/compose.ts";
import type { Emit } from "../ui/bubble.ts";
import { useSelected, useStateNow } from "../ui/presenter.ts";
import type { LineDraftChange, UiEvent } from "../ui/state.ts";

import { useT } from "../lib/i18n.ts";

export interface TerminalInputProps {
  owner: string;
  onComposing?: (active: boolean) => void;
  connected: boolean;
  /** an empty line's send: Enter alone, for a menu's default or a prompt that asks to continue */
  onEnter: () => boolean;
  /** the line's text goes up to the Root, which keeps it for its pane, and its sends */
  emit: Emit<TerminalInputEvent>;
}

/** the line sent (typed with its own Enter), and each edit of it */
export type TerminalInputEvent = { type: "send-line"; text: string } | Extract<UiEvent, { type: "line-draft" }>;

/** Lines the box grows to before it scrolls. */
const MAX_ROWS = 4;

/**
 * The terminal's input line on a touch screen. A phone's keyboard rewrites what it typed
 * (dictation revising a phrase, an IME finishing a syllable, autocorrect), and a terminal
 * cannot take back keys it already sent: every revision arrived as more text. Here the line
 * is written with the keyboard's own editing and goes to the pane whole, then Enter.
 */
export function TerminalInput({ owner, connected, onEnter, onComposing, emit }: TerminalInputProps) {
  const t = useT();
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const stateNow = useStateNow();
  // the line belongs to its PC and pane (the Mediator keeps it), never to the mounted view: a late
  // acknowledgement must not erase edits made in a newly mounted input for the same pane
  const line = useSelected((state) => state.drafts.line[owner]);
  const text = line?.text ?? "";
  const sending = line?.sending ?? false;
  const changeLine = useCallback((change: LineDraftChange) => emitRef.current({ type: "line-draft", owner, change }), [owner]);
  useLayoutEffect(() => changeLine({ kind: "read" }), [changeLine]);
  const setText = useCallback((value: string) => changeLine({ kind: "set", text: value }), [changeLine]);
  const composing = useRef(false);
  const composingCallback = useRef(onComposing);
  composingCallback.current = onComposing;
  useEffect(() => () => { composingCallback.current?.(false); }, []);

  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // what a send came to, as the Mediator says it once the pane answered (text typed meanwhile stays)
  const outcome = useSelected((state) => state.sends.outcomes[`line:${owner}`]);
  const seenOutcome = useRef(outcome);
  useEffect(() => {
    if (outcome === seenOutcome.current) return;
    seenOutcome.current = outcome;
    if (outcome === undefined) return;
    const said = outcome.outcome;
    if (said.kind === "sent") return;
    setNote(said.kind === "not-sent" ? t("Not sent: the terminal is disconnected.")
      : said.kind === "submit-failed" ? submitNote(said.code, said.message) : t("Not confirmed. Check the terminal before sending again."));
  }, [outcome, t]);

  const send = useCallback(() => {
    if (!connected || stateNow().drafts.line[owner]?.sending || composing.current) return;
    setNote(null);
    if (text.length === 0) {
      if (!onEnter()) setNote(t("Not sent: the terminal is disconnected."));
      return;
    }
    emitRef.current({ type: "send-line", text });
  }, [connected, onEnter, owner, stateNow, t, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter breaks the line; an IME keeps its Enter, including the committing
    // one WebKit can send after compositionend as key code 229
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  // wrapped lines count too: a dictated sentence is one long line, and its end must stay readable
  const [wrappedRows, setWrappedRows] = useState(1);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight);
    if (!(line > 0)) return;
    const shown = element.rows;
    element.rows = 1;
    const content = element.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    element.rows = shown;
    setWrappedRows(Math.max(1, Math.round(content / line)));
  }, [text]);
  const rows = Math.min(MAX_ROWS, Math.max(wrappedRows, text.split("\n").length));
  return (
    <div className="terminal-input">
      <textarea
        ref={box}
        className="terminal-input-text"
        rows={rows}
        value={text}
        maxLength={TERMINAL_LINE_LIMIT}
        onCompositionStart={() => { composing.current = true; onComposing?.(true); }}
        onCompositionEnd={() => { composing.current = false; onComposing?.(false); }}
        placeholder={t("Type for the terminal…")}
        aria-label={t("Terminal input line")}
        enterKeyHint="send"
        autoCapitalize="off"
        onChange={(event) => { setText(event.target.value); setNote(null); }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="terminal-input-send"
        aria-label={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        title={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        disabled={!connected || sending}
        // the soft keyboard stays up for the next line
        onPointerDown={(event) => event.preventDefault()}
        onClick={send}
      >
        {text.length === 0 ? <CornerDownLeft aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}
      </button>
      {note !== null && <p className="terminal-input-note" role="alert">{note}</p>}
    </div>
  );
}
