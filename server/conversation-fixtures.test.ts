import { describe, expect, test } from "bun:test";

import { loadCases, runCase, SOURCES, type CallStep, type LoadedCase } from "../scripts/conversation-fixtures.ts";

// fixtures/conversations: the conversation logs agents write and what the transcript readers
// return for them (scripts/conversation-fixtures.ts says how a case is laid out and how to add one)
const cases = loadCases();
const UPDATE = "write it with `bun scripts/conversation-fixtures.ts --update` and read the diff";

const calls = (loaded: LoadedCase): [number, CallStep][] =>
  loaded.spec.steps.flatMap((step, index) => "call" in step ? [[index, step] as [number, CallStep]] : []);

/** What each case's calls returned, in the order the cases run. */
async function runAll(order: LoadedCase[]): Promise<Map<string, unknown[]>> {
  const results = new Map<string, unknown[]>();
  for (const loaded of order) results.set(loaded.name, (await runCase(loaded)).values);
  return results;
}

describe("conversation corpus", () => {
  test("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const loaded of cases) {
    test(loaded.name, async () => {
      const { values } = await runCase(loaded);
      for (const [index, step] of calls(loaded)) {
        if (step.expected === undefined) throw new Error(`${loaded.name} step ${index} has no expected value: ${UPDATE}`);
        expect({ step: index, value: values[index] }).toStrictEqual({ step: index, value: step.expected });
      }
    });
  }

  test("answers the same when the cases run in the reverse order", async () => {
    const forward = await runAll(cases);
    const backward = await runAll([...cases].reverse());
    for (const { name } of cases) expect({ name, values: backward.get(name) }).toStrictEqual({ name, values: forward.get(name) });
  });

  // the runner routes each source's calls to its reader: the cases of every source a later issue fills
  test("routes every call of every source", () => {
    const routed = new Set(cases.flatMap((loaded) => calls(loaded).map(([, step]) => `${step.source}:${step.call}`)));
    const required: Record<typeof SOURCES[number], string[]> = {
      claude: ["page", "image", "toolOutput"],
      codex: ["page", "image", "toolOutput", "unansweredQuestions"],
      pi: ["page", "image", "toolOutput"],
      omp: ["page", "toolOutput"],
      opencode: ["page", "image", "toolOutput"],
    };
    const missing = Object.entries(required).flatMap(([source, names]) => names.map((call) => `${source}:${call}`)).filter((key) => !routed.has(key));
    expect(missing).toEqual([]);
  });
});
