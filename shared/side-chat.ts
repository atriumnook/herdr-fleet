import type { ConversationTurn } from "./protocol.ts";

/**
 * A side chat as the page draws it: questions asked beside a pane's conversation, answered by
 * Claude Code in print mode, and kept only while the server runs (GET /api/side-chats/events).
 */
export interface SideChatSnapshot {
  id: string;
  /** the pane whose conversation it is about */
  paneId: string;
  /**
   * `fork`: Claude goes on from a copy of the pane's own Claude session, as it stood when the side
   * chat opened. `context`: it was handed the pane's conversation (or its screen) as text.
   */
  source: "fork" | "context";
  /** `ended`: its process is gone (closed, or it stopped); a new side chat starts over */
  status: "working" | "idle" | "ended";
  turns: ConversationTurn[];
  /** the reply's text as it comes, before its message is whole */
  streaming: string;
  /** why a turn or the process failed, as Claude Code said it */
  error: string | null;
}

/** What GET /api/side-chats/events sends: the pane's side chat after each change, null when it has none. */
export interface SideChatEvent {
  chat: SideChatSnapshot | null;
}
