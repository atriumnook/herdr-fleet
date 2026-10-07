import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { EMPTY_VIEW } from "../ui/state.ts";
import { ChatView, type ChatViewModel } from "./ChatView.tsx";

const user = (text: string): ConversationTurn => ({ role: "user", ts: text, parts: [{ kind: "text", text }] });
const model = (extra: Partial<ChatViewModel> = {}): ChatViewModel => ({
  paneId: "w1:p1", connected: true, ended: false, agent: "claude", agentStatus: "idle", view: EMPTY_VIEW, fresh: true, older: [], olderCursor: undefined,
  olderState: "idle", historyId: "h1", error: null, loaded: true, abandoned: null, sentOver: null, prompt: null, pendingAnswer: null, showThinking: false, ...extra,
});

/** English, as under the app's own provider with an English browser */
function render(values: ChatViewModel): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(ChatView, { model: values, emit: () => {} }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("Chat view", () => {
  it("says it is loading until the first answer, then that nothing is said yet", () => {
    expect(render(model({ loaded: false }))).toContain("Loading conversation…");
    expect(render(model())).toContain("No conversation yet — say something below");
  });

  it("draws the earlier turns above the newest, and offers the page before them", () => {
    const html = render(model({ view: { ...EMPTY_VIEW, turns: [user("newest")] }, older: [user("earlier")], olderCursor: "c:10" }));
    expect(html.indexOf("earlier")).toBeLessThan(html.indexOf("newest"));
    expect(html).toContain(">Earlier messages</button>");
    expect(render(model({ view: { ...EMPTY_VIEW, turns: [user("a")] }, older: [user("b")], olderCursor: null }))).toContain("beginning of conversation");
    expect(render(model({ view: { ...EMPTY_VIEW, turns: [user("a")] }, olderCursor: "c:10", olderState: "failed" }))).toContain("Couldn&#x27;t load earlier messages — retry");
  });

  it("says why the conversation was not read, and a locked server in words", () => {
    expect(render(model({ error: { message: "502 bad gateway", status: 502 } }))).toContain("502 bad gateway");
    expect(render(model({ error: { message: "unauthorized", status: 401 } }))).toContain("locked — the token gate is asking again");
  });

  it("shows the scrollback folded for an agent, as messages without one", () => {
    const scrollback = { source: "scrollback" as const, turns: [], messages: [{ role: "agent" as const, text: "$ ls" }], truncated: false };
    expect(render(model({ view: scrollback }))).toContain("Conversation unavailable — show terminal output");
    expect(render(model({ view: scrollback, agent: null }))).not.toContain("Conversation unavailable");
  });

  it("says the pane is reconnecting, and ended", () => {
    expect(render(model({ connected: false }))).toContain("reconnecting…");
    expect(render(model({ ended: true }))).toContain("terminal ended");
  });
});
