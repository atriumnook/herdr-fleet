import { describe, expect, it } from "bun:test";
import { applyToDraft, besideHeldDraft, draftHoldsText, draftIsEmpty, EMPTY_DRAFT } from "./draft.ts";

describe("applyToDraft", () => {
  it("appends a printable character to the draft", () => {
    expect(applyToDraft(EMPTY_DRAFT, "a")).toEqual({ text: "a", droppedSpecial: 0 });
  });

  it("keeps the order of consecutive typed characters", () => {
    const draft = applyToDraft(applyToDraft(EMPTY_DRAFT, "l"), "s");
    expect(draft.text).toBe("ls");
  });

  it("counts a special key instead of drafting it", () => {
    const draft = applyToDraft(applyToDraft(EMPTY_DRAFT, "x"), "\r");
    expect(draft).toEqual({ text: "x", droppedSpecial: 1 });
  });

  it("counts escape sequences, arrows and control codes as special keys", () => {
    for (const special of ["\u001b[A", "\u0003", "\u001b", "\t"]) {
      expect(applyToDraft(EMPTY_DRAFT, special).droppedSpecial).toBe(1);
    }
  });

  it("caps the draft instead of growing without bound", () => {
    let draft = EMPTY_DRAFT;
    for (let i = 0; i < 1100; i += 1) draft = applyToDraft(draft, "x");
    expect(draft.text.length).toBe(1024);
    expect(draft.droppedSpecial).toBe(1100 - 1024);
  });

  it("treats DEL and non-printable single characters as special", () => {
    expect(applyToDraft(EMPTY_DRAFT, "\u007f").droppedSpecial).toBe(1);
  });
});

describe("draftIsEmpty", () => {
  it("is true for the empty draft and false once anything is held", () => {
    expect(draftIsEmpty(EMPTY_DRAFT)).toBe(true);
    expect(draftIsEmpty({ text: "", droppedSpecial: 1 })).toBe(false);
    expect(draftIsEmpty({ text: "a", droppedSpecial: 0 })).toBe(false);
  });
});

it("holds multi-codepoint IME commits without splitting a surrogate at the limit", () => {
  for (const text of ["한글", "😀", "e\u0301", "abc"]) expect(applyToDraft(EMPTY_DRAFT, text).text).toBe(text);
  expect(applyToDraft({ text: "a".repeat(1023), droppedSpecial: 0 }, "😀").text).toHaveLength(1023);
  expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~text\x1b[201~").text).toBe("");
});

describe("Backspace in a held draft", () => {
  it("takes back the last character typed, so a typo is fixed without discarding", () => {
    expect(applyToDraft(applyToDraft(EMPTY_DRAFT, "echo hx"), "\x7f")).toEqual({ text: "echo h", droppedSpecial: 0 });
    expect(applyToDraft(applyToDraft(EMPTY_DRAFT, "ok 👍"), "\b")).toEqual({ text: "ok ", droppedSpecial: 0 });
    // with no text there is nothing to take back: it is a key left out
    expect(applyToDraft(EMPTY_DRAFT, "\x7f")).toEqual({ text: "", droppedSpecial: 1 });
  });
});

describe("besideHeldDraft", () => {
  it("holds text, a paste, Backspace and line breaks, so nothing runs without the held start", () => {
    for (const input of ["rm -rf build", "x", "\r", "\n", "\x1b\r", "a\rb", "\x7f", "\b", "\x1b[200~ls\x1b[201~"]) expect(besideHeldDraft(input)).toBe("hold");
  });

  it("lets an interrupt and other control keys reach the program", () => {
    for (const input of ["\x03", "\x1b", "\t", "\x1b[A", "\x1b[D"]) expect(besideHeldDraft(input)).toBe("send");
  });

  it("counts a draft as held only when it holds text: keys left out hold no start", () => {
    expect(draftHoldsText(EMPTY_DRAFT)).toBe(false);
    expect(draftHoldsText(applyToDraft(EMPTY_DRAFT, "\r"))).toBe(false);
    expect(draftHoldsText(applyToDraft(EMPTY_DRAFT, "echo "))).toBe(true);
  });
});
