import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { askedKey, detectPlainQuestion, isEmptyDraft, endingQuestion, lastInstruction } from "./plainQuestion.ts";

const agent = (text: string, extra: ConversationTurn["parts"] = []): ConversationTurn => ({ role: "assistant", ts: "t2", parts: [...extra, { kind: "text", text }] });
const user = (text: string): ConversationTurn => ({ role: "user", ts: "t1", parts: [{ kind: "text", text }] });

describe("plain-text questions", () => {
  it("finds a question in Japanese and in English at the end of a reply", () => {
    expect(detectPlainQuestion("実装しました。\n\nこのままマージしますか？")?.question).toBe("このままマージしますか？");
    expect(detectPlainQuestion("Done with the parser.\n\nShould I also update the README?")?.question).toBe("Should I also update the README?");
    // an asking phrase without a question mark
    expect(detectPlainQuestion("どちらの方式で進めるか決めてください。どちらにしますか")?.question).toBe("どちらにしますか");
  });

  it("asks only by how the last sentence ends: a word like which or どちら elsewhere is not a question", () => {
    expect(detectPlainQuestion("Here is the config which I changed.")).toBeNull();
    expect(detectPlainQuestion("どちらも更新しました。")).toBeNull();
    expect(detectPlainQuestion("Do you want the long story? I fixed the parser and the tests pass.")).toBeNull();
    // a question further up was answered by the work after it
    expect(detectPlainQuestion("Should I add a test?\n\nI added one; it passes.")).toBeNull();
    expect(detectPlainQuestion("Done.\n\n**Should I push it?**")?.question).toBe("Should I push it?");
  });

  it("reads the last English sentence after a full stop, and leaves trailing quotes and backticks out", () => {
    expect(detectPlainQuestion("I updated the parser. Should I push?")?.question).toBe("Should I push?");
    expect(detectPlainQuestion("I updated the parser. Should I push? I will wait.")).toBeNull();
    expect(detectPlainQuestion("Should I use \"fast\"?")?.question).toBe("Should I use \"fast\"?");
    expect(detectPlainQuestion("Ready. Should I push it?\"")?.question).toBe("Should I push it?");
  });

  it("does not read a question mark in a quoted phrase, inline code or an address as the agent asking", () => {
    expect(detectPlainQuestion("The prompt now says \"Continue?\"")).toBeNull();
    expect(detectPlainQuestion("The installer asks 「続けますか？」")).toBeNull();
    expect(detectPlainQuestion("It runs `read -p Continue?`")).toBeNull();
    expect(detectPlainQuestion("The docs are at https://example.com/search?q=cache")).toBeNull();
  });

  it("leaves out courtesies that ask nothing to decide", () => {
    expect(detectPlainQuestion("Fixed the parser. Does that make sense?")).toBeNull();
    expect(detectPlainQuestion("以上です。ご不明な点はございませんか？")).toBeNull();
    expect(detectPlainQuestion("修正案を書きました。いかがでしょうか。")).toBeNull();
  });

  it("reads a long last line from its end", () => {
    const found = detectPlainQuestion(`${"word ".repeat(2_000)}and so on. Should I push the branch now?`);
    expect(found?.question).toBe("Should I push the branch now?");
    const long = detectPlainQuestion(`Should I ${"really ".repeat(100)}push?`);
    expect(long?.question.endsWith("really push?")).toBe(true);
    expect(long!.question.length).toBeLessThanOrEqual(300);
  });

  it("stays fast on a reply of many blank lines with a fence", () => {
    const reply = `${"\n".repeat(40_000)}\`\`\`\n${" \n".repeat(20_000)}Should I push?`;
    const started = performance.now();
    detectPlainQuestion(reply);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("leaves code blocks out: a question mark in code is not the agent asking", () => {
    expect(detectPlainQuestion("Updated the check:\n\n```ts\nconst ok = ready ? run() : wait();\nwhich?\n```")).toBeNull();
    expect(detectPlainQuestion("Which version should I pin?\n\n```json\n{ \"v\": 1 }\n```")?.question).toBe("Which version should I pin?");
    // a block left open at the end of the reply is code to the end
    expect(detectPlainQuestion("Run this:\n```sh\nread -p 'continue?'")).toBeNull();
  });

  it("leaves out courtesies and replies with no question", () => {
    expect(detectPlainQuestion("Fixed.\n\nLet me know if you need anything else?")).toBeNull();
    expect(detectPlainQuestion("修正しました。他に何かありますか？")).toBeNull();
    expect(detectPlainQuestion("All tests pass.")).toBeNull();
    expect(detectPlainQuestion("")).toBeNull();
  });

  it("reads the list after the question as its choices, with what follows a colon as their description", () => {
    const found = detectPlainQuestion("Two ways to go.\n\nWhich do you prefer?\n1. **Redis**: fast, one more service\n2. SQLite — no new service");
    expect(found?.options).toEqual([
      { label: "Redis", description: "fast, one more service" },
      { label: "SQLite", description: "no new service" },
    ]);
  });

  it("reads a list just before the question when none follows it", () => {
    const found = detectPlainQuestion("案は 2 つです。\n- A: 速い\n- B: 安全\nどちらにしますか？");
    expect(found?.options.map((option) => option.label)).toEqual(["A", "B"]);
  });

  it("keeps at most six choices", () => {
    const list = Array.from({ length: 9 }, (_, index) => `${index + 1}. option ${index + 1}`).join("\n");
    expect(detectPlainQuestion(`Which one?\n${list}`)?.options).toHaveLength(6);
  });

  it("asks only of the agent's last turn while it is not working, and only of what it said after its work", () => {
    const tool: ConversationTurn["parts"] = [{ kind: "tool", name: "Bash", summary: "ls", input: "{}", output: "" }];
    expect(endingQuestion([user("go"), agent("Should I push?")], false)?.question).toBe("Should I push?");
    expect(endingQuestion([user("go"), agent("Should I push?")], true)).toBeNull();
    expect(endingQuestion([agent("Should I push?"), user("yes")], false)).toBeNull();
    // narration before the last tool call is work, not the reply
    expect(endingQuestion([{ role: "assistant", ts: "t", parts: [{ kind: "text", text: "Which file should I read?" }, ...tool, { kind: "text", text: "Read it. Done." }] }], false)).toBeNull();
  });
});

describe("a written question's key and choice", () => {
  const question = { question: "Should I push?", options: [] };

  it("names two questions with the same words apart, also when the transcript keeps no time", () => {
    const first = askedKey(question, { historyId: "h1", ts: null, pageStart: "c:10", index: 3 });
    const second = askedKey(question, { historyId: "h1", ts: null, pageStart: "c:10", index: 7 });
    expect(first).not.toBe(second);
    expect(askedKey(question, { historyId: "h1", ts: null, pageStart: "c:20", index: 3 })).not.toBe(first);
    expect(askedKey(question, { historyId: "h1", ts: "t1", pageStart: "c:10", index: 3 })).toBe(askedKey(question, { historyId: "h1", ts: "t1", pageStart: "c:30", index: 0 }));
    expect(askedKey(question, { historyId: "h2", ts: "t1", pageStart: null, index: 0 })).not.toBe(askedKey(question, { historyId: "h1", ts: "t1", pageStart: null, index: 0 }));
  });

  it("goes into an empty message box only", () => {
    expect(isEmptyDraft("")).toBe(true);
    expect(isEmptyDraft("  \n")).toBe(true);
    expect(isEmptyDraft("use redis but")).toBe(false);
  });
});

describe("the person's last instruction", () => {
  it("is the newest user turn with text", () => {
    expect(lastInstruction([user("first"), agent("ok"), user("second"), agent("ok")])).toBe("second");
    expect(lastInstruction([user("first"), { role: "user", ts: null, parts: [{ kind: "notice", text: "task finished" }] }])).toBe("first");
    expect(lastInstruction([agent("hello")])).toBeNull();
  });

  it("is the person's, as the prompt rail reads it: not the fleet's message, and a pane's request without its pane line", () => {
    expect(lastInstruction([user("add a cache"), agent("ok"), user("[fleet] The thread t1 is ready for review.")])).toBe("add a cache");
    expect(lastInstruction([user("[from pane w1:p2]\n\nfix the login test")])).toBe("fix the login test");
  });
});
