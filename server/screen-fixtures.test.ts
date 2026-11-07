import { describe, expect, test } from "bun:test";

import { evaluate, loadCases, sameIds, type Evaluated } from "../scripts/screen-fixtures.ts";

// fixtures/screens: the screens agents draw and what the parsers in prompt.ts return for them
// (scripts/screen-fixtures.ts says how a case is laid out and how to add one)
const cases = loadCases();
const evaluated = new Map<string, Evaluated>();
const UPDATE = "write it with `bun scripts/screen-fixtures.ts --update` and read the diff";

describe("screen corpus", () => {
  test("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const loaded of cases) {
    test(loaded.name, () => {
      const result = evaluate(loaded);
      evaluated.set(loaded.name, result);
      if (loaded.spec.expected === undefined) throw new Error(`${loaded.name} has no expected value: ${UPDATE}`);
      expect(result.value).toStrictEqual(loaded.spec.expected);
      for (const [index, { expected }] of (loaded.spec.answers ?? []).entries()) {
        if (expected === undefined) throw new Error(`${loaded.name}'s answer ${index} has no expected keys: ${UPDATE}`);
        expect(result.answers[index]).toStrictEqual(expected);
      }
    });
  }

  test("gives the same card id to exactly the cases each case names", () => {
    const all = new Map(cases.map((loaded) => [loaded.name, evaluated.get(loaded.name) ?? evaluate(loaded)]));
    const same = sameIds(all);
    for (const { name, spec } of cases) expect({ name, sameIdAs: same.get(name) ?? [] }).toEqual({ name, sameIdAs: spec.sameIdAs ?? [] });
  });
});
