import type { ConversationTurn } from "../../shared/protocol.ts";
import { fromPane } from "../../shared/fleet.ts";
import { FLEET_MESSAGE, userText } from "./promptRail.ts";
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
const COURTESY = /(他に|ほかに|何か(あれば|ありましたら|気になる)|お気軽に|いつでも|ご不明な点|いかがでしょうか|お役に立て|anything else|let me know if|feel free|any (other )?questions|need anything|happy to help|does (that|this) (make sense|help|work for you)|makes sense\?|sounds? good\?)/i;
/** a Japanese sentence that asks, by how it ends; an English one asks with a question mark */
const ASKING_END = /(ますか|ですか|でしょうか|ましょうか|ませんか)[。．.]?$/;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•]|[A-Z][.)])\s+(.+)$/;
/** a fenced code block, or one left open at the end: code is never the question. Only spaces and tabs before a fence: `\s` would reach over blank lines, and a reply of many of them took time growing with its square */
const CODE_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
/** where a sentence ends: a Japanese stop, or an English one before a space (a `?` inside an address does not end one) */
const SENTENCE_END = /(?<=[。？！])(?![」』”"’'）)])\s*|(?<=[?!.])\s+/;
/** what in a sentence is not the agent asking: a quoted phrase, inline code, an address */
const NOT_ASKING = /"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|`[^`\n]*`|https?:\/\/\S+/g;
/** a long last line is read from its end: the question is there */
const LINE_TAIL = 600;
const QUESTION_CHARS = 300;

/** A list item, or a line indented under one. */
const inList = (line: string): boolean => LIST_ITEM.test(line) || /^\s+\S/.test(line);

/**
 * The reply's last sentence, if it asks: it ends with a question mark, or with a Japanese asking
 * ending. A list after it is read as its choices, else a list just before it. Code blocks are left
 * out first, and nothing above the last sentence counts: a question further up was answered by the
 * work after it.
 */
export function detectPlainQuestion(answer: string): PlainQuestion | null {
  const lines = answer.replace(CODE_BLOCK, "").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
  // a list that ends the reply holds the choices; the question is the sentence above it
  let end = lines.length;
  while (end > 0 && (inList(lines[end - 1]!) || lines[end - 1]!.trim().length === 0)) end -= 1;
  const trailing = lines.slice(end).filter((line) => line.trim().length > 0);
  if (end === 0) return null;
  const at = end - 1;
  // markup alone after the last stop ("**" closing a bold question) is no sentence
  const sentences = lines[at]!.slice(-LINE_TAIL).split(SENTENCE_END).map((sentence) => sentence.trim()).filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
  const sentence = sentences[sentences.length - 1] ?? "";
  // markdown, quotes and backticks around the sentence (**, a heading's #) are not part of how it ends
  const trim = (text: string): string => text.replace(/^[#>*\s]+/, "").replace(/[*_`"'”’」』\s]+$/, "");
  const last = trim(sentence);
  // a question mark inside a quoted phrase, code or an address is not the agent asking ("The prompt says "Continue?"")
  const asking = trim(sentence.replace(NOT_ASKING, " "));
  if (!(/[?？]$/.test(asking) || ASKING_END.test(asking)) || COURTESY.test(last)) return null;
  const leading: string[] = [];
  if (trailing.length === 0) {
    for (let index = at - 1; index >= 0 && inList(lines[index]!); index -= 1) leading.unshift(lines[index]!);
  }
  const optionLines = (trailing.length > 0 ? trailing : leading).filter((line) => LIST_ITEM.test(line));
  const options = optionLines
    .map((line) => LIST_ITEM.exec(line)?.[1])
    .filter((item): item is string => item !== undefined)
    .slice(0, MAX_OPTIONS)
    .map((item) => {
      const [label = "", ...rest] = item.split(/[:：]| — | - /);
      const description = rest.join(" ").trim().slice(0, 200);
      return { label: label.replace(/\*\*/g, "").trim().slice(0, 80), description: description.length > 0 ? description : null };
    });
  return { question: last.length > QUESTION_CHARS ? `…${last.slice(-(QUESTION_CHARS - 1))}` : last, options };
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

/**
 * What names a written question among the pane's, for its explanation: its turn's time, or, for a
 * transcript that keeps none, where the turn sits (the page's start and the turn's place in it), so
 * the same words asked twice are two questions. A replaced transcript (`historyId`) starts anew.
 */
export function askedKey(question: PlainQuestion, at: { historyId: string | undefined; ts: string | null; pageStart: string | null | undefined; index: number }): string {
  const place = at.ts ?? `${at.pageStart ?? "-"}+${at.index}`;
  return `plain:${at.historyId ?? ""}:${place}:${question.question}`;
}

/** A choice picked in the card goes into an empty message box only: text the person is writing stays as it is. */
export function isEmptyDraft(draft: string): boolean {
  return draft.trim().length === 0;
}

/** The person's newest message in the conversation: the text they typed, not a notice or a compaction. */
export function lastInstruction(turns: readonly ConversationTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.role !== "user") continue;
    // as the prompt rail reads them: the fleet's own messages are not the person's, and a request
    // sent from a pane is what it asks, without the line naming that pane
    const said = userText(turn);
    if (said.startsWith(FLEET_MESSAGE)) continue;
    const text = (fromPane(said)?.text ?? said).trim();
    if (text.length > 0) return text;
  }
  return null;
}
