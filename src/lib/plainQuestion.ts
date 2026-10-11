import type { ConversationTurn } from "../../shared/protocol.ts";
import { splitTurn } from "./workBlocks.ts";

/**
 * A question an agent wrote at the end of its reply instead of opening a question screen, found
 * without a model. The test is a guess, so what it finds is offered in the chat only: it never
 * counts as the pane needing the person. Adapted from qa-guide's detectWaiting (claude_qamods by
 * aieo-product, MIT; see NOTICE).
 */
export interface PlainQuestion {
  question: string;
  /** a list next to the question, read as its choices (at most MAX_OPTIONS) */
  options: { label: string; description: string | null }[];
}

const MAX_OPTIONS = 6;
/** closing courtesies: "anything else?" asks nothing to decide */
const COURTESY = /(他に|ほかに|何か(あれば|ありましたら|気になる)|お気軽に|いつでも|anything else|let me know if|feel free|any (other )?questions|need anything|happy to help)/i;
const ASKING = /(しますか|ますか|でしょうか|どうしますか|よろしいですか|どちら|どれ|いかがですか|ませんか|\b(should i|shall i|would you like|do you want|which|what would you prefer|can you confirm|ok to|okay to)\b)/i;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•]|[A-Z][.)])\s+(.+)$/;

/** The last question sentence of a reply's text, if it reads like the agent waiting on a decision. */
export function detectPlainQuestion(answer: string): PlainQuestion | null {
  const text = answer.trim();
  if (text.length === 0) return null;
  const sentences = text.slice(-600).split(/(?<=[。？！?!])\s*|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
  const last = [...sentences].reverse().find((sentence) => /[?？]$/.test(sentence) || ASKING.test(sentence));
  if (last === undefined || COURTESY.test(last)) return null;
  // only the reply's last lines count: a question further up was answered by the work after it
  const lines = text.split("\n").slice(-12);
  const at = lines.map((line) => line.includes(last.slice(0, 20))).lastIndexOf(true);
  if (at < 0) return null;
  const listed = (from: number, step: 1 | -1): string[] => {
    const found: string[] = [];
    for (let index = from; index >= 0 && index < lines.length; index += step) {
      const line = lines[index]!;
      if (LIST_ITEM.test(line)) { if (step === 1) found.push(line); else found.unshift(line); }
      else if (line.trim().length > 0 && (found.length === 0 || !/^\s+\S/.test(line))) break;
    }
    return found;
  };
  // the choices follow the question, or lead up to it
  const after = listed(at + 1, 1);
  const optionLines = after.length > 0 ? after : listed(at - 1, -1);
  const options = optionLines
    .map((line) => LIST_ITEM.exec(line)?.[1])
    .filter((item): item is string => item !== undefined)
    .slice(0, MAX_OPTIONS)
    .map((item) => {
      const [label = "", ...rest] = item.split(/[:：]| — | - /);
      const description = rest.join(" ").trim().slice(0, 200);
      return { label: label.replace(/\*\*/g, "").trim().slice(0, 80), description: description.length > 0 ? description : null };
    });
  return { question: last.replace(/^[#>*\s]+/, "").slice(0, 300), options };
}

/** What the agent said at the end of its turn: the text after its last action. */
export function answerText(turn: ConversationTurn): string {
  return splitTurn(turn.parts).answer.map((part) => part.text).join("\n\n");
}

/**
 * The question the conversation ends on: the last turn is the agent's, it is not working, and no
 * question screen is up (that one is answered in its own card).
 */
export function endingQuestion(turns: readonly ConversationTurn[], working: boolean): PlainQuestion | null {
  const last = turns[turns.length - 1];
  if (working || last === undefined || last.role !== "assistant") return null;
  return detectPlainQuestion(answerText(last));
}

/** The person's newest message in the conversation: the text they typed, not a notice or a compaction. */
export function lastInstruction(turns: readonly ConversationTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.role !== "user") continue;
    const text = turn.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n").trim();
    if (text.length > 0) return text;
  }
  return null;
}
