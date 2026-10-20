import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "../shared/protocol.ts";
import { conversationContext, screenContext } from "./side-chat-context.ts";

const pane = { title: "fix the build", agent: "claude", cwd: "/repo" };
const turn = (role: "user" | "assistant", ...parts: ConversationTurn["parts"]): ConversationTurn => ({ role, ts: null, parts });

describe("what a side chat reads of a pane", () => {
  it("writes the conversation as Markdown: words, tool calls, summaries, but not reasoning or pictures", () => {
    const text = conversationContext(pane, [
      turn("user", { kind: "text", text: "Why does it fail?" }, { kind: "image", media_type: "image/png", ref: "r1" }),
      turn("assistant",
        { kind: "thinking", text: "secret reasoning" },
        { kind: "tool", name: "Bash", summary: "bun test", input: "bun test", output: "1 fail", error: true },
        { kind: "text", text: "One test fails." }),
      turn("user", { kind: "compact", text: "Earlier they set up CI." }),
    ]);
    expect(text).toContain("Pane: fix the build (claude)\nFolder: /repo");
    expect(text).toContain("## Person\n\nWhy does it fail?");
    expect(text).toContain("## claude\n\nTool `Bash` (failed): bun test");
    expect(text).toContain("One test fails.");
    expect(text).toContain("Summary of the conversation before this point:\n\nEarlier they set up CI.");
    expect(text).not.toContain("secret reasoning");
    expect(text).not.toContain("r1");
  });

  it("keeps the newest turns that fit, and says how many it left out", () => {
    const turns = Array.from({ length: 50 }, (_, index) => turn("user", { kind: "text", text: `message ${index} ${"x".repeat(100)}` }));
    const text = conversationContext(pane, turns, 2000);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(2001);
    expect(text).toContain("message 49");
    expect(text).not.toContain("message 0 ");
    expect(text).toMatch(/\(\d+ earlier turns left out\)/);
  });

  it("fences a tool's output longer than any backticks inside it", () => {
    const text = conversationContext(pane, [turn("assistant", { kind: "tool", name: "Read", summary: "README", input: "", output: "```ts\ncode\n```" })]);
    expect(text).toContain("````\n```ts\ncode\n```\n````");
  });

  it("hands over a pane's screen when it keeps no conversation", () => {
    const text = screenContext({ title: "shell", agent: null, cwd: "/repo" }, "$ make\nerror: x\n");
    expect(text).toContain("# The terminal the person asks about");
    expect(text).toContain("```\n$ make\nerror: x\n```");
  });
});
