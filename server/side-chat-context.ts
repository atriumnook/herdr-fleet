import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";

/** the most of a conversation a side chat is handed: the newest turns that fit */
export const SIDE_CHAT_CONTEXT_BYTES = 200 * 1024;
/** the most of one tool call's output kept: what it showed, not all of it */
const TOOL_OUTPUT_CHARS = 2000;

/** What the side chat is told of the pane before the conversation. */
export interface ContextPane {
  title: string;
  agent: string | null;
  cwd: string | null;
}

function heading(pane: ContextPane, what: string): string {
  return [
    `# ${what}`,
    "",
    `Pane: ${pane.title}${pane.agent ? ` (${pane.agent})` : ""}`,
    ...(pane.cwd ? [`Folder: ${pane.cwd}`] : []),
    `Written: ${new Date().toISOString()}`,
  ].join("\n");
}

function fenced(text: string): string {
  // a fence longer than any run of backticks inside
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function part(item: ConversationPart): string | null {
  switch (item.kind) {
    case "text":
      return item.text.trim() || null;
    case "tool": {
      const output = item.output.length > TOOL_OUTPUT_CHARS ? `${item.output.slice(0, TOOL_OUTPUT_CHARS)}\n… (output cut)` : item.output;
      return [`Tool \`${item.name}\`${item.error ? " (failed)" : ""}: ${item.summary}`, ...(item.input.trim() ? [fenced(item.input)] : []), ...(output.trim() ? [fenced(output)] : [])].join("\n");
    }
    case "compact":
      return `Summary of the conversation before this point:\n\n${item.text.trim()}`;
    case "notice":
      return `(notice) ${item.text.trim()}`;
    case "skill":
      return `(skill ${item.skill.name}: ${item.skill.status})`;
    // reasoning is the agent's own, and pictures are not text
    case "thinking":
    case "image":
      return null;
  }
}

function turn(item: ConversationTurn, agent: string | null): string {
  const who = item.role === "user" ? "Person" : agent ?? "Agent";
  const parts = item.parts.map(part).filter((text): text is string => text !== null);
  return [`## ${who}${item.ts ? ` (${item.ts})` : ""}`, "", ...parts.flatMap((text) => [text, ""])].join("\n").trimEnd();
}

/** A pane's conversation as one Markdown text: the newest turns that fit, oldest first. */
export function conversationContext(pane: ContextPane, turns: readonly ConversationTurn[], limit = SIDE_CHAT_CONTEXT_BYTES): string {
  const head = heading(pane, "The conversation the person asks about");
  const encoder = new TextEncoder();
  // room for the line that says how many turns were left out, and the last newline
  let used = encoder.encode(head).length + 64;
  const kept: string[] = [];
  for (let index = turns.length - 1; index >= 0; index--) {
    const text = turn(turns[index]!, pane.agent);
    const size = encoder.encode(text).length + 2;
    if (used + size > limit) break;
    kept.unshift(text);
    used += size;
  }
  const left = turns.length - kept.length;
  return [head, ...(left > 0 ? [`(${left} earlier turn${left === 1 ? "" : "s"} left out)`] : []), ...kept].join("\n\n") + "\n";
}

/** A pane with no conversation to read (a shell, an agent that keeps none): its screen instead. */
export function screenContext(pane: ContextPane, screen: string, limit = SIDE_CHAT_CONTEXT_BYTES): string {
  const head = heading(pane, "The terminal the person asks about");
  const text = screen.length > limit ? screen.slice(screen.length - limit) : screen;
  return `${head}\n\nIts screen and scrollback, newest last:\n\n${fenced(text.trimEnd())}\n`;
}
