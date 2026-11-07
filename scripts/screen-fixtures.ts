/**
 * The screen corpus: what the screen parsers return for screens agents draw.
 *
 * Each case is a folder `fixtures/screens/<agent>/<case>/` holding
 * - `screen.txt`: the screen as the pane drew it, ANSI included, byte for byte
 * - `case.json`: the call to make on it, and what that call returns (`expected`)
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
 * which rewrites every case's `expected`, `sameIdAs` and answers' `expected` from what the
 * code returns now. Read the diff before committing it.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import type { QueuedQuestion } from "../server/codex.ts";
import {
  answerKeys, codexQueuedPrompt, codexQuestionsCollapsed, parseClaudeSuggestion, parseFallbackPrompt, parseInteractivePrompt,
  type AnswerStep, type QueueFront,
} from "../server/prompt.ts";

export const SCREENS_DIR = join(import.meta.dir, "..", "fixtures", "screens");

type Answer = Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">;

export interface ScreenCase {
  call: "parseInteractivePrompt" | "parseFallbackPrompt" | "codexQueuedPrompt" | "codexQuestionsCollapsed" | "parseClaudeSuggestion";
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
  const result = call(screen, spec);
  const prompt = result !== null && typeof result === "object" ? result as InteractivePrompt : null;
  if (spec.answers?.length && !prompt) throw new Error("answers are given for a call that returned no card");
  const { id = null, ...rest } = prompt ?? {};
  return {
    value: JSON.parse(JSON.stringify(prompt ? rest : result)) as unknown,
    id,
    answers: (spec.answers ?? []).map(({ answer }) => JSON.parse(JSON.stringify(answerKeys(prompt!, answer))) as AnswerStep[]),
  };
}

function call(screen: string, spec: ScreenCase): unknown {
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

function update(): void {
  const cases = loadCases();
  const evaluated = new Map(cases.map((loaded) => [loaded.name, evaluate(loaded)]));
  const same = sameIds(evaluated);
  for (const { name, dir, spec } of cases) {
    const result = evaluated.get(name)!;
    const sameIdAs = same.get(name) ?? [];
    const next: ScreenCase = {
      call: spec.call,
      ...(spec.agent === undefined ? {} : { agent: spec.agent }),
      ...(spec.unanswered === undefined ? {} : { unanswered: spec.unanswered }),
      ...(spec.front === undefined ? {} : { front: spec.front }),
      expected: result.value,
      ...(sameIdAs.length ? { sameIdAs } : {}),
      ...(spec.answers?.length ? { answers: spec.answers.map(({ answer }, index) => ({ answer, expected: result.answers[index]! })) } : {}),
    };
    writeFileSync(join(dir, "case.json"), `${JSON.stringify(next, null, 2)}\n`);
  }
  console.log(`updated ${cases.length} cases in ${SCREENS_DIR}`);
}

if (import.meta.main) {
  if (process.argv[2] !== "--update") {
    console.error("Usage: bun scripts/screen-fixtures.ts --update");
    process.exit(2);
  }
  update();
}
