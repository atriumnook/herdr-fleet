/**
 * The prompt rail: the person's own prompts in the chat, one tick each, to read on hover and jump
 * back to. Only what the person typed is a prompt: a compaction, a runtime notice and a `[fleet]`
 * message are not. The rail lists the turns the chat has read (the newest page and the earlier
 * pages loaded above it); earlier ones come in with the chat's own "Earlier messages".
 * The turn line and the word search follow oikon48's prompt-rail (MIT, see NOTICE).
 */
import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { patchFiles, patchText } from "../../shared/patch.ts";
import { fromPane } from "../../shared/fleet.ts";
import { formatWorkDuration, workSummary } from "./workBlocks.ts";
import { t } from "./i18n.ts";

/** how the fleet opens what it types into an agent itself (server/fleet/orchestrator.ts) */
export const FLEET_MESSAGE = "[fleet] ";

/** One prompt on the rail. */
export interface RailEntry {
  /** the prompt's turn time, as its row in the chat carries it (`data-turn-ts`) */
  ts: string;
  /** the prompt's own key: its time, and which of the prompts with that time it is (two sent within one tick of a coarse clock share it) */
  key: string;
  /** where the prompt sits among the turns read, 0 at the first and 1 at the last */
  at: number;
  /** what the person typed (a request sent from a pane without its `[from pane …]` line); empty for a message of images alone */
  text: string;
  /** the turn that opens the prompt, and the agent's turns that answer it: what entryLine sums up */
  turn: ConversationTurn;
  answer: readonly ConversationTurn[];
}

/** The text a user turn holds, its parts joined as the chat shows them. */
export function userText(turn: ConversationTurn): string {
  return turn.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n\n");
}

/**
 * Each turn read, as a prompt: what the person typed, or null for a turn that is no prompt. A turn
 * that did not change keeps its object across polls, so a long chat reads each turn once.
 */
const prompts = new WeakMap<ConversationTurn, string | null>();

function promptText(turn: ConversationTurn): string | null {
  const known = prompts.get(turn);
  if (known !== undefined) return known;
  let text: string | null = null;
  if (turn.role === "user" && turn.ts !== null && !turn.parts.some((part) => part.kind === "compact" || part.kind === "notice")) {
    const said = userText(turn);
    if (!said.startsWith(FLEET_MESSAGE) && (said.trim().length > 0 || turn.parts.some((part) => part.kind === "image"))) text = fromPane(said)?.text ?? said;
  }
  prompts.set(turn, text);
  return text;
}

/** Whether a turn is a prompt the person typed: a user turn with text or images, not the fleet's message nor the runtime's. */
export function isPrompt(turn: ConversationTurn): boolean {
  return promptText(turn) !== null;
}

/**
 * Each time's key, in order: the time and how many before it had the same one (`t#0`, `t#1`). The
 * rail keys its prompts so, and the chat its prompt rows, both in the order they read.
 */
export function occurrenceKeys(times: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return times.map((ts) => {
    const n = seen.get(ts) ?? 0;
    seen.set(ts, n + 1);
    return `${ts}#${n}`;
  });
}

/** The prompts among the turns read, in order, each with the agent's turns that answer it. */
export function railEntries(turns: readonly ConversationTurn[]): RailEntry[] {
  const starts = turns.flatMap((turn, index) => (isPrompt(turn) ? [index] : []));
  const keys = occurrenceKeys(starts.map((start) => turns[start]!.ts!));
  const last = Math.max(1, turns.length - 1);
  return starts.map((start, n) => {
    const turn = turns[start]!;
    const answer = turns.slice(start + 1, starts[n + 1] ?? turns.length).filter((reply) => reply.role === "assistant");
    return { ts: turn.ts!, key: keys[n]!, at: turns.length === 1 ? 0 : start / last, text: promptText(turn)!, turn, answer };
  });
}

/** Each prompt's turn line, with the last answering turn it was made from: a turn still running makes it again. */
const lines = new WeakMap<ConversationTurn, { last: ConversationTurn | undefined; count: number; line: string }>();

/**
 * The turn a prompt started on one line: `1m 23s · 2 edits · app.ts, README.md`, empty when
 * nothing is known. It reads every tool call of the turn, so it is made only for a prompt shown
 * with it (the card pointed at, the sheet, the palette's rows), and kept while the turn holds.
 */
export function entryLine(entry: RailEntry): string {
  const last = entry.answer.at(-1);
  const known = lines.get(entry.turn);
  if (known !== undefined && known.last === last && known.count === entry.answer.length) return known.line;
  const line = turnLine(entry.turn, entry.answer);
  lines.set(entry.turn, { last, count: entry.answer.length, line });
  return line;
}

/** the files a turn line names before it counts the rest */
const NAMED_FILES = 3;

const segments = (path: string): string[] => path.split(/[\\/]/).filter(Boolean);

/** Each path by its file name, or by its folder and name where two share one. */
export function fileNames(paths: readonly string[]): string[] {
  const base = (path: string): string => segments(path).at(-1) ?? path;
  return paths.map((path) => (paths.some((other) => other !== path && base(other) === base(path)) ? segments(path).slice(-2).join("/") : base(path)));
}

/** The files a tool call wrote, as its input names them (an edit's path, or every file a Codex patch touches). */
function writtenFiles(part: Extract<ConversationPart, { kind: "tool" }>): string[] {
  const patch = patchText(part.input);
  if (patch !== null) return patchFiles(patch);
  if (!/edit|write|create_file/i.test(part.name)) return [];
  try {
    const input = JSON.parse(part.input) as Record<string, unknown>;
    const path = input["file_path"] ?? input["path"];
    return typeof path === "string" ? [path] : [];
  } catch { return []; }
}

/** The turn a prompt started on one line: how long it ran, what the agent did, the files it wrote. */
export function turnLine(prompt: ConversationTurn, answer: readonly ConversationTurn[]): string {
  const parts = answer.flatMap((turn) => turn.parts);
  const end = answer.at(-1);
  const files = [...new Set(parts.flatMap((part) => (part.kind === "tool" ? writtenFiles(part) : [])))];
  const names = fileNames(files);
  const rest = names.length - NAMED_FILES;
  return [
    formatWorkDuration(prompt.ts, end?.end_ts ?? end?.ts ?? null),
    workSummary(parts),
    names.length > 0 ? `${names.slice(0, NAMED_FILES).join(", ")}${rest > 0 ? ` +${rest}` : ""}` : "",
  ].filter((item): item is string => item !== null && item.length > 0).join(" · ");
}

/** The prompts that hold every word asked for (any case), newest first. */
export function findPrompts(entries: readonly RailEntry[], query: string): RailEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return entries.filter((entry) => {
    const text = entry.text.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  }).reverse();
}

/** What a step from the prompt being read lands on: a prompt's index, the earlier page, or the end. */
export type StepTarget = { kind: "prompt"; index: number } | { kind: "earlier" } | { kind: "end" } | { kind: "none" };

/**
 * A step back or on from the prompt being read (`reading`: its index, -1 above the first). Back from
 * the middle of a turn goes to the top of its own prompt first; back from the first goes to the
 * earlier page when there is one, and on from the last goes to the end of the chat.
 */
export function stepFrom(reading: number, count: number, direction: -1 | 1, midTurn: boolean, earlier: boolean): StepTarget {
  if (count === 0) return direction === -1 ? (earlier ? { kind: "earlier" } : { kind: "none" }) : { kind: "end" };
  if (direction === 1) return reading + 1 < count ? { kind: "prompt", index: reading + 1 } : { kind: "end" };
  if (midTurn && reading >= 0) return { kind: "prompt", index: reading };
  if (reading - 1 >= 0) return { kind: "prompt", index: reading - 1 };
  return earlier ? { kind: "earlier" } : reading === 0 ? { kind: "prompt", index: 0 } : { kind: "none" };
}

/** A prompt's first line, for a list row: the images alone say so. */
export function promptTitle(entry: RailEntry): string {
  const first = entry.text.split("\n").find((line) => line.trim().length > 0)?.trim();
  return first ?? t("Images");
}
