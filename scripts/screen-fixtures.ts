/**
 * The screen corpus: what the screen parsers return for screens agents draw.
 *
 * Each case is a folder `fixtures/screens/<agent>/<case>/` holding
 * - `screen.txt`: a screen as a pane draws it, ANSI included. Most were written by hand in the
 *   likeness of one, for the tests they came from; none says which CLI version drew it. The
 *   file's bytes are what the call reads, unchanged
 * - `case.json`: what the case shows (`about`: the tests it was recorded from), the call to make
 *   on the screen, and what that call returns (`expected`): a parser of prompt.ts (`call`), or an
 *   agent adapter's look at the screen (`adapter` and `check`). A check that finds nothing
 *   returns undefined, written as null
 *
 * A card's `id` is left out of `expected`, since only which cards share one matters, not
 * how it is computed: `sameIdAs` names the other cases whose card has the same id, and a
 * case it leaves out has a different one. `answers` are the keys answerKeys sends for an
 * answer to the case's card.
 *
 * server/screen-fixtures.test.ts checks every case. To add one, put its screen.txt and a
 * case.json without `expected` in a new folder, then run
 *
 *     bun scripts/screen-fixtures.ts --update
 *
 * which writes what the code returns now into the cases that have no expected value yet (an
 * answer without `expected` counts), and records which other cases share their card's id. A
 * case that has one is left as it is: a failing case is a question of whether the code or the
 * case is wrong, not something to write over. To rewrite cases the code now rightly answers
 * differently, name them:
 *
 *     bun scripts/screen-fixtures.ts --update claude/some-case codex/another
 *
 * Read the diff before committing it. Fields of case.json this script does not write are kept.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import type { QueuedQuestion } from "../server/codex.ts";
import {
  answerKeys, codexQueuedPrompt, codexQuestionsCollapsed, parseClaudeSuggestion, parseFallbackPrompt, parseInteractivePrompt,
  type AnswerStep, type QueueFront,
} from "../server/prompt.ts";
import { adapterFor } from "../server/fleet/adapters.ts";
import type { AgentKind } from "../server/fleet/types.ts";

export const SCREENS_DIR = join(import.meta.dir, "..", "fixtures", "screens");

type Answer = Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">;

/** an agent adapter's look at a screen (server/fleet/adapters.ts) */
type Check = "startupError" | "question" | "readyError" | "inputReady" | "draft" | "turnError";

export interface ScreenCase {
  /** what the case shows: the tests it was recorded from */
  about?: string;
  call?: "parseInteractivePrompt" | "parseFallbackPrompt" | "codexQueuedPrompt" | "codexQuestionsCollapsed" | "parseClaudeSuggestion";
  adapter?: AgentKind;
  check?: Check;
  /** the agent the parse is for (parseInteractivePrompt, parseFallbackPrompt) */
  agent?: string;
  /** codexQueuedPrompt: the questions the rollout holds no answer for, and the question the queue opened on */
  unanswered?: QueuedQuestion[];
  front?: QueueFront | null;
  expected?: unknown;
  sameIdAs?: string[];
  answers?: { answer: Answer; expected?: AnswerStep[] }[];
}

export interface LoadedCase { name: string; dir: string; screen: string; spec: ScreenCase }

export function loadCases(root = SCREENS_DIR): LoadedCase[] {
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((agent) =>
    readdirSync(join(root, agent.name), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
      const dir = join(root, agent.name, entry.name);
      return {
        name: `${agent.name}/${entry.name}`,
        dir,
        screen: readFileSync(join(dir, "screen.txt"), "utf8"),
        spec: JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as ScreenCase,
      };
    })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface Evaluated {
  /** what the call returned, the card's id left out, as JSON reads it back */
  value: unknown;
  id: string | null;
  answers: AnswerStep[][];
}

export function evaluate({ screen, spec }: Pick<LoadedCase, "screen" | "spec">): Evaluated {
  return readResult(call(screen, spec), spec);
}

/** What a case's call returned, as the case compares it: an object is a card. */
export function readResult(result: unknown, spec: Pick<ScreenCase, "answers">): Evaluated {
  const prompt = result !== null && typeof result === "object" ? result as InteractivePrompt : null;
  if (spec.answers?.length && !prompt) throw new Error("answers are given for a call that returned no card");
  const { id, ...rest } = prompt ?? {};
  // a card names itself by its id: one without is a broken card, not one without twins
  if (prompt && (typeof id !== "string" || id === "")) throw new Error("the call returned a card without an id");
  return {
    value: JSON.parse(JSON.stringify(prompt ? rest : result ?? null)) as unknown,
    id: prompt ? id! : null,
    answers: (spec.answers ?? []).map(({ answer }) => JSON.parse(JSON.stringify(answerKeys(prompt!, answer))) as AnswerStep[]),
  };
}

function call(screen: string, spec: ScreenCase): unknown {
  if (spec.adapter !== undefined || spec.check !== undefined) {
    if (spec.adapter === undefined || spec.check === undefined || spec.call !== undefined) throw new Error("a check needs an adapter and a check, and no call");
    const look = adapterFor(spec.adapter)[spec.check] as ((screen: string) => unknown) | undefined;
    if (!look) throw new Error(`the ${spec.adapter} adapter has no ${spec.check}`);
    return look.call(adapterFor(spec.adapter), screen);
  }
  switch (spec.call) {
    case "parseInteractivePrompt": return parseInteractivePrompt(agentOf(spec), screen);
    case "parseFallbackPrompt": return parseFallbackPrompt(agentOf(spec), screen);
    case "codexQueuedPrompt": return codexQueuedPrompt(screen, spec.unanswered ?? [], spec.front ?? null);
    case "codexQuestionsCollapsed": return codexQuestionsCollapsed(screen);
    case "parseClaudeSuggestion": return parseClaudeSuggestion(screen);
    default: throw new Error(`unknown call: ${String(spec.call)}`);
  }
}

function agentOf(spec: ScreenCase): string {
  if (!spec.agent) throw new Error(`${spec.call} needs an agent`);
  return spec.agent;
}

/** For each case whose call returned a card, the other cases whose card has the same id. */
export function sameIds(evaluated: Map<string, Evaluated>): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const [name, { id }] of evaluated) if (id !== null) byId.set(id, [...byId.get(id) ?? [], name]);
  const same = new Map<string, string[]>();
  for (const names of byId.values()) for (const name of names) same.set(name, names.filter((other) => other !== name).sort());
  return same;
}

/** A case without an expected value, for itself or for one of its answers. */
function unfilled(spec: ScreenCase): boolean {
  return spec.expected === undefined || (spec.answers ?? []).some(({ expected }) => expected === undefined);
}

/**
 * Writes what the code returns now into the cases that have no expected value yet and into the
 * cases `names` names, and nothing else: another case only gains or loses the names of these in
 * its `sameIdAs`. Returns the cases written.
 */
export function update(names: string[] = [], root = SCREENS_DIR): string[] {
  const cases = loadCases(root);
  const known = new Set(cases.map(({ name }) => name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`no such case: ${unknown.join(", ")}`);
  const targets = new Set([...names, ...cases.filter(({ spec }) => unfilled(spec)).map(({ name }) => name)]);
  const evaluated = new Map(cases.map((loaded) => [loaded.name, evaluate(loaded)]));
  const same = sameIds(evaluated);
  for (const { name, dir, spec } of cases) {
    const computed = same.get(name) ?? [];
    let next: ScreenCase;
    if (targets.has(name)) {
      const result = evaluated.get(name)!;
      next = {
        ...spec,
        expected: result.value,
        sameIdAs: computed,
        ...(spec.answers?.length ? { answers: spec.answers.map((each, index) => ({ ...each, expected: result.answers[index]! })) } : {}),
      };
    } else {
      // only its relations to the cases written here change
      const sameIdAs = [...(spec.sameIdAs ?? []).filter((other) => !targets.has(other)), ...computed.filter((other) => targets.has(other))].sort();
      if (sameIdAs.join("\n") === (spec.sameIdAs ?? []).join("\n")) continue;
      next = { ...spec, sameIdAs };
    }
    if (!next.sameIdAs?.length) delete next.sameIdAs;
    writeFileSync(join(dir, "case.json"), `${JSON.stringify(next, null, 2)}\n`);
  }
  return [...targets].sort();
}

if (import.meta.main) {
  const [flag, ...names] = process.argv.slice(2);
  if (flag !== "--update") {
    console.error("Usage: bun scripts/screen-fixtures.ts --update [<agent>/<case> ...]");
    process.exit(2);
  }
  const written = update(names);
  console.log(written.length ? `wrote ${written.length} cases:\n${written.join("\n")}` : "every case has its expected values: name the cases to rewrite");
}
