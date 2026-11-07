import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluate, readResult, update, type ScreenCase } from "./screen-fixtures.ts";

const CODEX_MENU = `
Would you like to run the following command?
echo hi
› 1. Yes, proceed
  2. No, cancel
Press enter to confirm or esc to cancel
`;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function corpus(cases: Record<string, { screen: string; spec: ScreenCase }>): string {
  const root = mkdtempSync(join(tmpdir(), "screen-fixtures-"));
  roots.push(root);
  for (const [name, { screen, spec }] of Object.entries(cases)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "screen.txt"), screen);
    writeFileSync(join(root, name, "case.json"), JSON.stringify(spec));
  }
  return root;
}
const read = (root: string, name: string) => JSON.parse(readFileSync(join(root, name, "case.json"), "utf8")) as ScreenCase;
const menu = { call: "parseInteractivePrompt", agent: "codex" } as const;

describe("screen corpus update", () => {
  test("fills only the cases without expected values, and leaves a stale one as it is", () => {
    const root = corpus({
      "codex/new": { screen: CODEX_MENU, spec: { ...menu, answers: [{ answer: { option_index: 1 } }] } },
      "codex/stale": { screen: CODEX_MENU, spec: { ...menu, expected: "not what the code returns" } },
    });
    expect(update([], root)).toEqual(["codex/new"]);
    const filled = read(root, "codex/new");
    expect(filled.expected).toEqual(evaluate({ screen: CODEX_MENU, spec: menu }).value);
    expect(filled.answers).toEqual([{ answer: { option_index: 1 }, expected: [{ keys: ["esc"] }] }]);
    expect(read(root, "codex/stale").expected).toBe("not what the code returns");
  });

  test("rewrites a case it is given by name", () => {
    const root = corpus({ "codex/stale": { screen: CODEX_MENU, spec: { ...menu, expected: "not what the code returns" } } });
    expect(update(["codex/stale"], root)).toEqual(["codex/stale"]);
    expect(read(root, "codex/stale").expected).toEqual(evaluate({ screen: CODEX_MENU, spec: menu }).value);
  });

  test("keeps the fields it does not write", () => {
    const root = corpus({ "codex/new": { screen: CODEX_MENU, spec: { about: "why", ...menu, note: "kept" } as ScreenCase } });
    update([], root);
    expect(read(root, "codex/new")).toMatchObject({ about: "why", note: "kept" });
  });

  test("records a new case's id twins on both sides, and no other change to the case it leaves", () => {
    const root = corpus({
      "codex/old": { screen: CODEX_MENU, spec: { ...menu, expected: "kept as written" } },
      "codex/new": { screen: CODEX_MENU, spec: menu },
    });
    update([], root);
    expect(read(root, "codex/new").sameIdAs).toEqual(["codex/old"]);
    expect(read(root, "codex/old")).toEqual({ ...menu, expected: "kept as written", sameIdAs: ["codex/new"] });
  });

  test("refuses a name that is no case", () => {
    const root = corpus({ "codex/new": { screen: CODEX_MENU, spec: menu } });
    expect(() => update(["codex/missing"], root)).toThrow("no such case: codex/missing");
  });
});

describe("screen corpus evaluation", () => {
  const card = { agent: "codex", kind: "approval", title: "t", question: "q", body: null, options: [], multi_select: false, custom_option_index: null };

  test("refuses a card without an id", () => {
    expect(() => readResult(card, {})).toThrow("without an id");
    expect(() => readResult({ ...card, id: "" }, {})).toThrow("without an id");
  });

  test("leaves the id out of the value, and has none for what is not a card", () => {
    expect(readResult({ ...card, id: "abc" }, {})).toEqual({ value: card, id: "abc", answers: [] });
    expect(readResult(undefined, {})).toEqual({ value: null, id: null, answers: [] });
    expect(readResult(false, {})).toEqual({ value: false, id: null, answers: [] });
  });
});
