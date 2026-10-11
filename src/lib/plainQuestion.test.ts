import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { detectPlainQuestion, endingQuestion, lastInstruction } from "./plainQuestion.ts";

const agent = (text: string, extra: ConversationTurn["parts"] = []): ConversationTurn => ({ role: "assistant", ts: "t2", parts: [...extra, { kind: "text", text }] });
const user = (text: string): ConversationTurn => ({ role: "user", ts: "t1", parts: [{ kind: "text", text }] });

describe("plain-text questions", () => {
  it("finds a question in Japanese and in English at the end of a reply", () => {
    expect(detectPlainQuestion("実装しました。\n\nこのままマージしますか？")?.question).toBe("このままマージしますか？");
    expect(detectPlainQuestion("Done with the parser.\n\nShould I also update the README?")?.question).toBe("Should I also update the README?");
    // an asking phrase without a question mark
    expect(detectPlainQuestion("どちらの方式で進めるか決めてください。どちらにしますか")?.question).toBe("どちらにしますか");
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

describe("the person's last instruction", () => {
  it("is the newest user turn with text", () => {
    expect(lastInstruction([user("first"), agent("ok"), user("second"), agent("ok")])).toBe("second");
    expect(lastInstruction([user("first"), { role: "user", ts: null, parts: [{ kind: "notice", text: "task finished" }] }])).toBe("first");
    expect(lastInstruction([agent("hello")])).toBeNull();
  });
});
