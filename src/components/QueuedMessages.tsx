import { MAX_COMPOSER_CHARS, submitNote } from "../lib/compose.ts";
import type { HeldMessage } from "../lib/messageQueue.ts";
import { useT } from "../lib/i18n.ts";
import type { Emit } from "../ui/bubble.ts";
import type { QueueState } from "../ui/state.ts";

/** What the held messages draw: the pane's list, the one going out, why the last did not, and whether one may go now. */
export interface QueuedMessagesModel {
  messages: HeldMessage[];
  /** this device could not keep them */
  unsaved: boolean;
  /** the one going out now (any pane's: one at a time) */
  sending: string | null;
  anySending: boolean;
  error: QueueState["error"];
  /** the terminal takes a message now (connected, not held, no masked prompt) */
  canSend: boolean;
  /** Codex has a question open in the terminal: nothing may be typed into it */
  heldByOpenQueue: boolean;
  /** the agent is at rest: a held message is the person's to review and send */
  ready: boolean;
}

export type QueuedMessagesEvent =
  | { type: "queue-edit"; id: string; text: string }
  | { type: "queue-discard"; id: string }
  | { type: "queue-send"; id: string; text: string };

/** Messages held while the agent works: edited in place, sent one at a time when the person says so, or discarded. */
export function QueuedMessages({ model, emit }: { model: QueuedMessagesModel; emit: Emit<QueuedMessagesEvent> }) {
  const t = useT();
  const { messages, unsaved, sending, anySending, error, canSend, heldByOpenQueue, ready } = model;
  const said = (note: NonNullable<QueueState["error"]>["note"]): string => note.kind === "submit-failed" ? submitNote(note.code, note.message)
    : note.kind === "not-sent" ? t("Not sent. Reconnect and try again.") : t("Not confirmed. Check the terminal before sending again.");
  return (
    <section className="composer-queue" aria-label={t("Queued messages")}>
      <div className="composer-queue-heading">
        <strong>{t("Queued messages ({n})", { n: messages.length })}</strong>
        <span className="composer-queue-label">{t(ready ? "Held message — review and send" : "Held until the agent is ready")}</span>
      </div>
      {unsaved && <p className="composer-queue-error" role="status">{t("Queue could not be saved. Keep this tab open or copy the messages before reloading.")}</p>}
      <ol className="composer-queue-list">
      {messages.map((message, index) => <li className="composer-queue-item" key={message.id}>
        <label className="composer-queue-label" htmlFor={`queued-${message.id}`}>{t("Message {n}", { n: index + 1 })}</label>
        <textarea
          id={`queued-${message.id}`}
          className="composer-queue-text"
          value={message.text}
          rows={Math.min(4, message.text.split("\n").length)}
          aria-label={t("Queued message {n}", { n: index + 1 })}
          maxLength={MAX_COMPOSER_CHARS}
          disabled={sending === message.id}
          spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onChange={(event) => emit({ type: "queue-edit", id: message.id, text: event.target.value })}
        />
        <div className="composer-queue-actions">
          <button type="button" className="composer-queue-send"
            disabled={!canSend || anySending || heldByOpenQueue || message.text.trim().length === 0}
            title={heldByOpenQueue ? t("Codex has a question open in the terminal: answer it above first") : undefined}
            onClick={() => emit({ type: "queue-send", id: message.id, text: message.text })}>{t("Send now")}</button>
          <button type="button" className="composer-queue-discard" disabled={sending === message.id}
            onClick={() => emit({ type: "queue-discard", id: message.id })}>{t("Discard")}</button>
        </div>
        {error !== null && error.id === message.id && <p className="composer-queue-error" role="status">{said(error.note)}</p>}
      </li>)}
      </ol>
    </section>
  );
}
