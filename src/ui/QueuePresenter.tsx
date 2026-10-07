import { useEffect, useRef } from "react";
import { QueuedMessages, type QueuedMessagesEvent } from "../components/QueuedMessages.tsx";
import type { HeldMessage } from "../lib/messageQueue.ts";
import type { Emit } from "./bubble.ts";
import type { UiEvent } from "./state.ts";
import { useSelected } from "./presenter.ts";

export type QueueUpEvent = Extract<UiEvent, { type: "queue-open" | "queue-edit" | "queue-discard" }> | { type: "queue-send"; owner: string; id: string; text: string };

/** no held messages: the same empty list each time */
const NO_MESSAGES: HeldMessage[] = [];

export interface QueuePresenterProps {
  /** the pane's storage id */
  owner: string;
  canSend: boolean;
  heldByOpenQueue: boolean;
  ready: boolean;
  /** the list shows: the chat lens on a pane that takes messages */
  shown: boolean;
  emit: Emit<QueueUpEvent>;
}

/**
 * The held messages' Presenter, inside the pane's terminal (not yet migrated): the pane's list as
 * the store keeps it, read once the pane shows, and what the terminal says of sending. The events
 * go up naming the pane.
 */
export function QueuePresenter({ owner, canSend, heldByOpenQueue, ready, shown, emit }: QueuePresenterProps) {
  const emitRef = useRef(emit);
  emitRef.current = emit;
  useEffect(() => emitRef.current({ type: "queue-open", owner }), [owner]);
  const messages = useSelected((state) => state.queue.lists[owner] ?? NO_MESSAGES);
  const unsaved = useSelected((state) => state.queue.unsaved[owner] === true);
  const sending = useSelected((state) => (state.queue.sending?.owner === owner ? state.queue.sending.id : null));
  const anySending = useSelected((state) => state.queue.sending !== null);
  const error = useSelected((state) => (state.queue.error?.owner === owner ? state.queue.error : null));
  if (!shown || messages.length === 0) return null;
  const up = (event: QueuedMessagesEvent): void => emit({ ...event, owner });
  return <QueuedMessages model={{ messages, unsaved, sending, anySending, error, canSend, heldByOpenQueue, ready }} emit={up} />;
}
