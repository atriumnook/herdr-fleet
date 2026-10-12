/** What a conversation read can say instead of turns (conversation.ts and the stores behind it). */

export class ConversationUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConversationUnavailable";
  }
}

/** A cursor from another transcript: the pane started a new session, or a Codex backtrack replaced the file. */
export class HistoryChanged extends Error {
  constructor() {
    super("the conversation's transcript changed; reload it from its newest turns");
    this.name = "HistoryChanged";
  }
}
