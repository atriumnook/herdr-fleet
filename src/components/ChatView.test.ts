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
  olderState: "idle", historyId: "h1", error: null, loaded: true, abandoned: null, sentOver: null, prompt: null, pendingAnswer: null, card: null, showThinking: false, seek: null, ...extra,
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

  it("draws the prompt rail over the chat for two prompts or more, one tick each, and none for the scrollback", () => {
    const fleet: ConversationTurn = { role: "user", ts: "f", parts: [{ kind: "text", text: "[fleet] a thread finished" }] };
    const two = render(model({ view: { ...EMPTY_VIEW, turns: [user("first"), fleet, user("second")] } }));
    expect(two).toContain('class="prompt-rail"');
    expect(two.match(/class="prompt-rail-tick/g)?.length).toBe(2);
    expect(two).toContain('aria-label="Prompt 2 of 2: second"');
    expect(two).toContain('data-turn-ts="first"');
    expect(two).toContain('class="chat-view has-rail"');
    expect(render(model({ view: { ...EMPTY_VIEW, turns: [user("only"), fleet] } }))).not.toContain("prompt-rail");
    // one prompt with earlier pages left: the rail offers them
    const earlier = render(model({ view: { ...EMPTY_VIEW, turns: [user("only")] }, olderCursor: "c:10" }));
    expect(earlier).toContain('class="prompt-rail-earlier"');
    const scrollback = { source: "scrollback" as const, turns: [], messages: [{ role: "user" as const, text: "a" }, { role: "user" as const, text: "b" }], truncated: false };
    expect(render(model({ view: scrollback }))).not.toContain("prompt-rail");
  });

  it("marks a request sent from a pane's conversation with that pane, and offers it while it is open", () => {
    // a time of its own: the prompt rail marks a prompt's row with its time, which `user` makes of the text
    const asked = { ...user("[from pane w2:p3]\n\nFix the doubled login error."), ts: "2026-10-11T10:00:00Z" };
    const open = render(model({ view: { ...EMPTY_VIEW, turns: [asked] }, askedFrom: new Map([["w2:p3", "herdr-fleet · claude"]]) }));
    expect(open).toContain("From a pane");
    expect(open).toContain("herdr-fleet · claude");
    expect(open).toContain(">Open pane</button>");
    expect(open).toContain("Fix the doubled login error.");
    expect(open).not.toContain("[from pane");
    // it is a prompt of the person's: its row carries the time the prompt rail jumps to
    expect(open).toContain('data-turn-ts="2026-10-11T10:00:00Z"');
    const closed = render(model({ view: { ...EMPTY_VIEW, turns: [asked] }, askedFrom: new Map([["w2:p3", null]]) }));
    expect(closed).toContain("Closed pane");
    expect(closed).not.toContain("Open pane");
    // a message the person typed on the Fleet screen has no such line
    expect(render(model({ view: { ...EMPTY_VIEW, turns: [user("What is left?")] } }))).not.toContain("From a pane");
  });

  it("says the pane is reconnecting, and ended", () => {
    expect(render(model({ connected: false }))).toContain("reconnecting…");
    expect(render(model({ ended: true }))).toContain("terminal ended");
  });
});
