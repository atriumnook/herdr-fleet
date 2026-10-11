import { describe, expect, it } from "bun:test";
import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { fileNames, findPrompts, isPrompt, promptTitle, railEntries, stepFrom, turnLine } from "./promptRail.ts";

const user = (ts: string, text: string, extra: ConversationPart[] = []): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "text", text }, ...extra] });
const tool = (name: string, input: unknown): ConversationPart => ({ kind: "tool", name, summary: "", input: typeof input === "string" ? input : JSON.stringify(input), output: "" });
const agent = (ts: string, parts: ConversationPart[], end_ts?: string): ConversationTurn => ({ role: "assistant", ts, parts, ...(end_ts ? { end_ts } : {}) });

describe("isPrompt", () => {
  it("takes what the person typed, and images sent alone", () => {
    expect(isPrompt(user("t1", "fix the build"))).toBe(true);
    expect(isPrompt({ role: "user", ts: "t2", parts: [{ kind: "image", media_type: "image/png", ref: "r" }] })).toBe(true);
  });

  it("leaves out the fleet's messages, compactions, runtime notices, empty turns and turns without a time", () => {
    expect(isPrompt(user("t1", "[fleet] The thread needs you."))).toBe(false);
    expect(isPrompt({ role: "user", ts: "t2", parts: [{ kind: "compact", text: "summary" }] })).toBe(false);
    expect(isPrompt({ role: "user", ts: "t3", parts: [{ kind: "notice", text: "background result" }] })).toBe(false);
    expect(isPrompt(user("t4", "  "))).toBe(false);
    expect(isPrompt({ role: "user", ts: null, parts: [{ kind: "text", text: "hi" }] })).toBe(false);
    expect(isPrompt(agent("t5", [{ kind: "text", text: "done" }]))).toBe(false);
  });
});

describe("railEntries", () => {
  it("lists the prompts in order, each placed by where its turn sits and summed up by the turns that answer it", () => {
    const turns = [
      user("2026-10-11T10:00:00Z", "first"),
      agent("2026-10-11T10:00:05Z", [tool("Edit", { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" }), tool("Bash", { command: "bun test" })], "2026-10-11T10:01:28Z"),
      user("2026-10-11T10:02:00Z", "[fleet] a thread finished"),
      agent("2026-10-11T10:02:05Z", [{ kind: "text", text: "noted" }]),
      user("2026-10-11T10:03:00Z", "second"),
    ];
    const entries = railEntries(turns);
    expect(entries.map((entry) => [entry.ts, entry.at, entry.text])).toEqual([
      ["2026-10-11T10:00:00Z", 0, "first"],
      ["2026-10-11T10:03:00Z", 1, "second"],
    ]);
    // the fleet's message is no prompt: the first prompt's turn runs on through it
    expect(entries[0]!.line).toBe("2m 5s · 1 edit · 1 command · app.ts");
    expect(entries[1]!.line).toBe("");
  });

  it("is empty with no prompt, and puts a lone prompt at the top", () => {
    expect(railEntries([])).toEqual([]);
    expect(railEntries([user("t1", "only")])[0]!.at).toBe(0);
  });
});

describe("turnLine", () => {
  it("names up to three written files, telling apart two that share a name, and counts the rest", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a/index.ts\n*** Add File: src/b/index.ts\n*** End Patch";
    const answer = [agent("t2", [
      tool("apply_patch", patch),
      tool("Write", { file_path: "README.md", content: "x" }),
      tool("Edit", { file_path: "docs/x.md", old_string: "", new_string: "y" }),
      tool("Edit", { file_path: "docs/y.md", old_string: "", new_string: "y" }),
      tool("Read", { file_path: "ignored.ts" }),
    ])];
    expect(turnLine(user("t1", "go"), answer)).toBe("4 edits · 1 file read · a/index.ts, b/index.ts, README.md +2");
  });

  it("is empty for a turn the agent has not answered", () => {
    expect(turnLine(user("t1", "go"), [])).toBe("");
  });
});

describe("fileNames", () => {
  it("uses the base name unless another path shares it", () => {
    expect(fileNames(["/a/x.ts", "/b/x.ts", "/c/y.ts"])).toEqual(["a/x.ts", "b/x.ts", "y.ts"]);
  });
});

describe("findPrompts", () => {
  const entries = railEntries([user("t1", "Fix the Login page"), user("t2", "add a test"), user("t3", "login again, please")]);
  it("finds every prompt holding all the words, any case, newest first", () => {
    expect(findPrompts(entries, "login").map((entry) => entry.ts)).toEqual(["t3", "t1"]);
    expect(findPrompts(entries, "LOGIN page").map((entry) => entry.ts)).toEqual(["t1"]);
  });
  it("finds nothing for an empty query or words no prompt holds", () => {
    expect(findPrompts(entries, "  ")).toEqual([]);
    expect(findPrompts(entries, "deploy")).toEqual([]);
  });
});

describe("stepFrom", () => {
  it("goes on to the next prompt, and past the last to the end", () => {
    expect(stepFrom(0, 3, 1, false, false)).toEqual({ kind: "prompt", index: 1 });
    expect(stepFrom(2, 3, 1, false, false)).toEqual({ kind: "end" });
    expect(stepFrom(-1, 3, 1, false, false)).toEqual({ kind: "prompt", index: 0 });
  });

  it("goes back to the top of the prompt being read from the middle of its turn, else to the one before", () => {
    expect(stepFrom(2, 3, -1, true, false)).toEqual({ kind: "prompt", index: 2 });
    expect(stepFrom(2, 3, -1, false, false)).toEqual({ kind: "prompt", index: 1 });
  });

  it("goes back from the first prompt to the earlier page when there is one", () => {
    expect(stepFrom(0, 3, -1, false, true)).toEqual({ kind: "earlier" });
    expect(stepFrom(0, 3, -1, false, false)).toEqual({ kind: "prompt", index: 0 });
    expect(stepFrom(-1, 3, -1, false, true)).toEqual({ kind: "earlier" });
  });

  it("with no prompt read, goes on to the end, and back to the earlier page or nowhere", () => {
    expect(stepFrom(-1, 0, 1, false, false)).toEqual({ kind: "end" });
    expect(stepFrom(-1, 0, 1, false, true)).toEqual({ kind: "end" });
    expect(stepFrom(-1, 0, -1, false, true)).toEqual({ kind: "earlier" });
    expect(stepFrom(-1, 0, -1, false, false)).toEqual({ kind: "none" });
  });
});

describe("promptTitle", () => {
  it("is the first line with text, or says the prompt was images", () => {
    expect(promptTitle(railEntries([user("t1", "\n  first line \nsecond")])[0]!)).toBe("first line");
    expect(promptTitle(railEntries([{ role: "user", ts: "t2", parts: [{ kind: "image", media_type: "image/png", ref: "r" }] }])[0]!)).toBe("Images");
  });
});
