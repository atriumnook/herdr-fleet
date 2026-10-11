import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import type { ConversationTurn, InteractivePrompt } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS, SettingsProvider } from "../lib/settings.ts";
import { EMPTY_VIEW } from "../ui/state.ts";
import { ChatView, type ChatViewModel } from "./ChatView.tsx";
import { t } from "../lib/i18n.ts";

const user = (text: string): ConversationTurn => ({ role: "user", ts: text, parts: [{ kind: "text", text }] });
const model = (extra: Partial<ChatViewModel> = {}): ChatViewModel => ({
  paneId: "w1:p1", connected: true, ended: false, agent: "claude", agentStatus: "idle", view: EMPTY_VIEW, fresh: true, older: [], olderCursor: undefined,
  olderState: "idle", historyId: "h1", error: null, loaded: true, abandoned: null, sentOver: null, prompt: null, pendingAnswer: null, card: null, showThinking: false, ...extra,
});

/** English, as under the app's own provider with an English browser */
function render(values: ChatViewModel): string {
  return renderBare(createElement(SettingsProvider, { settings: DEFAULT_SETTINGS, onChange: () => {}, children: createElement(ChatView, { model: values, emit: () => {} }) }));
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
    expect(render(model({ error: { message: "unauthorized", status: 401 } }))).toContain(t("This server asks for the access token or a pairing code again."));
  });

  it("shows the scrollback folded for an agent, as messages without one", () => {
    const scrollback = { source: "scrollback" as const, turns: [], messages: [{ role: "agent" as const, text: "$ ls" }], truncated: false };
    expect(render(model({ view: scrollback }))).toContain("Conversation unavailable — show terminal output");
    expect(render(model({ view: scrollback, agent: null }))).not.toContain("Conversation unavailable");
  });

  it("holds the prompt's card while its answer goes, and says why one was refused", () => {
    const prompt: InteractivePrompt = { id: "p", agent: "claude", kind: "approval", title: "Allow?", question: "Edit?", body: null, options: [{ label: "Yes", description: null }], multi_select: false, custom_option_index: null };
    expect(render(model({ prompt, card: { promptId: "p", status: "pending" } }))).toContain('aria-busy="true"');
    expect(render(model({ prompt, card: { promptId: "p", status: "failed", message: "boom" } }))).toContain(">boom</p>");
    expect(render(model({ prompt, card: { promptId: "p", status: "changed", seq: 1 } }))).toContain("the prompt changed — re-read");
    // an answer for the prompt before says nothing of this one
    const other = render(model({ prompt, card: { promptId: "q", status: "failed", message: "boom" } }));
    expect(other).not.toContain("boom");
    expect(other).toContain('aria-busy="false"');
  });

  it("says the pane is reconnecting, and ended", () => {
    expect(render(model({ connected: false }))).toContain("reconnecting…");
    expect(render(model({ ended: true }))).toContain("terminal ended");
  });

  it("offers a written question's choices and an explanation, without saying the pane needs you", () => {
    const asked = { question: "Which store should I use?", options: [{ label: "Redis", description: "fast" }, { label: "SQLite", description: null }] };
    const html = render(model({ view: { ...EMPTY_VIEW, turns: [user("pick")] }, asked }));
    expect(html).toContain("Which store should I use?");
    expect(html).toContain(">Redis</span>");
    expect(html).toContain(" Explain</button>");
    expect(html).not.toContain("Needs you");
    // a question screen up is answered in its own card
    const prompt: InteractivePrompt = { id: "p", agent: "claude", kind: "approval", title: "Allow?", question: "Edit?", body: null, options: [{ label: "Yes", description: null }], multi_select: false, custom_option_index: null };
    expect(render(model({ asked, prompt }))).not.toContain("Which store should I use?");
  });

  it("shows the person's last message on the question screen's card, and what Claude Haiku said of it", () => {
    const prompt: InteractivePrompt = { id: "p", agent: "codex", kind: "approval", title: "Allow?", question: "Run the migration?", body: null, options: [{ label: "Yes", description: null }], multi_select: false, custom_option_index: null };
    const html = render(model({ prompt, instruction: "migrate the users table\nthen run the tests", promptExplanation: { status: "done", text: "### 推奨\n→ 1. Yes", model: "haiku", tokens: { input: 1200, output: 80 } } }));
    expect(html).toContain("Your last message");
    expect(html).toContain("migrate the users table");
    expect(html).toContain("推奨");
    expect(html).toContain("haiku · 1k in · 80 out");
    expect(render(model({ prompt, promptExplanation: { status: "loading" } }))).toContain("Explaining…");
    expect(render(model({ prompt, promptExplanation: { status: "failed", message: "claude has used 95% of its 5h limit", limited: true } }))).toContain(t("Claude was not asked. {reason}", { reason: "claude has used 95% of its 5h limit" }));
  });
});
