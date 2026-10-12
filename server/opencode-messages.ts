/**
 * OpenCode 2's session messages -> the conversation the chat renders. Pure: the CLI that reads
 * them is opencode-session.ts. A model step is one `assistant` message, so a user's prompt is
 * followed by a chain of them; the turn is what the chat shows, not the message.
 */
import type { ConversationMetadata, ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { record } from "./transcript-records.ts";
import { trimOutput } from "./tool-output.ts";

type Row = Record<string, unknown>;
type ToolPart = Extract<ConversationPart, { kind: "tool" }>;

/** The image types a chat shows; any other file is a line naming it. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Message ids are `msg_` and letters, digits, `_`, `-`: a ref made of one is safe to put in a URL. */
export const OPENCODE_MESSAGE_ID = /^msg_[A-Za-z0-9_-]{1,100}$/;
/** `<message id>:<index>`: a user image's index in `files`, or a tool's index in `content` (0 for a shell command). */
export const OPENCODE_REF = /^(msg_[A-Za-z0-9_-]{1,100}):(\d{1,4})$/;

/** a notice is a line the reader opens on request, not the model's whole instructions */
const NOTICE_CHARS = 4000;

const text = (value: unknown): string => typeof value === "string" ? value : "";
const iso = (ms: unknown): string | null => typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** A message that opens a turn: the person's prompt, or text the runtime put in the user's seat. */
export const startsTurn = (message: Row): boolean => message["type"] === "user" || message["type"] === "synthetic";

/** What a tool wrote: its text, with a line for each file it returned (the file itself is not read). */
function contentText(content: unknown): string {
  return (Array.isArray(content) ? content : []).map((value) => {
    const part = record(value);
    if (part["type"] === "text") return text(part["text"]);
    if (part["type"] === "file") return `[file: ${text(part["name"]) || text(part["mime"]) || "file"}]`;
    return "";
  }).filter((line) => line.length > 0).join("\n");
}

/** The one line a collapsed tool chip shows. */
function summaryOf(name: string, input: Row): string {
  for (const key of ["command", "filePath", "file_path", "path", "pattern", "description", "url", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value.split("\n")[0]!.slice(0, 120);
  }
  return name;
}

/** The tool call at `content[index]` of an assistant message, or a shell command, as a part with its whole output. */
export function toolOutputOf(message: unknown, index: number): string | null {
  const row = record(message);
  if (row["type"] === "shell") return index === 0 ? text(record(row["output"])["output"]) : null;
  const tool = record(Array.isArray(row["content"]) ? row["content"][index] : undefined);
  if (row["type"] !== "assistant" || tool["type"] !== "tool") return null;
  return toolResult(record(tool["state"])).output;
}

function toolResult(state: Row): { output: string; error: boolean } {
  if (state["status"] === "completed") {
    const metadata = record(state["metadata"]);
    // fleet's rule for every agent: a command that exited non-zero failed, whatever its status says
    return { output: contentText(state["content"]), error: typeof metadata["exit"] === "number" && metadata["exit"] !== 0 };
  }
  if (state["status"] === "error") {
    return { output: contentText(state["content"]) || text(record(state["error"])["message"]), error: true };
  }
  return { output: "", error: false };
}

/** `index` is the tool's place in the message's content: the ref its whole output is fetched by. */
function toolPart(messageId: string, index: number, tool: Row): ToolPart {
  const name = text(tool["name"]) || "tool";
  const state = record(tool["state"]);
  const streaming = typeof state["input"] === "string";
  const input = streaming ? {} : record(state["input"]);
  const part: ToolPart = {
    kind: "tool",
    name,
    summary: summaryOf(name, input),
    input: streaming ? state["input"] as string : JSON.stringify(input, null, 2),
    output: "",
  };
  const result = toolResult(state);
  trimOutput(part, result.output, `${messageId}:${index}`);
  if (result.error) part.error = true;
  return part;
}

function shellPart(message: Row): ToolPart {
  const command = text(message["command"]);
  const part: ToolPart = { kind: "tool", name: "bash", summary: summaryOf("bash", { command }), input: command, output: "" };
  trimOutput(part, text(record(message["output"])["output"]), `${text(message["id"])}:0`);
  const status = message["status"];
  if ((typeof message["exit"] === "number" && message["exit"] !== 0) || status === "timeout" || status === "killed") part.error = true;
  return part;
}

export interface ParsedMessages {
  turns: ConversationTurn[];
  /** the id of each turn's first message: the cursor a page starting at that turn carries */
  firstIds: string[];
}

/**
 * Messages oldest first, those a staged revert hides already left out. A `user` or `synthetic`
 * message opens a turn, and what follows it until the next such message is one assistant turn.
 * Ids are never compared: the list's order is the order.
 */
export function parseOpencodeMessages(messages: readonly unknown[]): ParsedMessages {
  const turns: ConversationTurn[] = [];
  const firstIds: string[] = [];
  /** the assistant turn being filled; null until a message needs one */
  let assistant: ConversationTurn | null = null;

  const push = (turn: ConversationTurn, id: string): ConversationTurn => { turns.push(turn); firstIds.push(id); return turn; };
  const userTurn = (message: Row, parts: ConversationPart[]): void => {
    assistant = null;
    push({ role: "user", ts: iso(record(message["time"])["created"]), parts }, text(message["id"]));
  };
  const assistantTurn = (message: Row): ConversationTurn => {
    if (assistant === null) assistant = push({ role: "assistant", ts: iso(record(message["time"])["created"]), parts: [] }, text(message["id"]));
    const time = record(message["time"]);
    const end = iso(time["completed"] ?? time["created"]);
    if (end !== null) assistant.end_ts = end;
    return assistant;
  };

  for (const value of messages) {
    const message = record(value);
    const id = text(message["id"]);
    switch (message["type"]) {
      case "user": {
        const parts: ConversationPart[] = [];
        if (text(message["text"]).length > 0) parts.push({ kind: "text", text: text(message["text"]) });
        (Array.isArray(message["files"]) ? message["files"] : []).forEach((value, index) => {
          const file = record(value);
          const mime = text(file["mime"]);
          if (IMAGE_TYPES.has(mime)) parts.push({ kind: "image", media_type: mime, ref: `${id}:${index}` });
          else parts.push({ kind: "text", text: `[file: ${text(file["name"]) || mime || "file"}]` });
        });
        userTurn(message, parts);
        break;
      }
      case "synthetic":
      case "system": {
        // `description` is the short summary meant for a transcript; `text` is what the model was told (an instructions delta, whole)
        const body = (text(message["description"]) || text(message["text"])).trim().slice(0, NOTICE_CHARS);
        if (body.length > 0) userTurn(message, [{ kind: "notice", text: body }]);
        break;
      }
      case "skill": {
        // `name` is the skill's name as shown; `skill` is its id
        const name = text(message["name"]) || text(message["skill"]);
        if (name.length > 0) assistantTurn(message).parts.push({ kind: "skill", skill: { name, evidence: "instructions", status: "loaded" } });
        break;
      }
      case "shell":
        assistantTurn(message).parts.push(shellPart(message));
        break;
      case "compaction": {
        const summary = text(message["summary"]);
        if (message["status"] === "completed" && summary.trim().length > 0) userTurn(message, [{ kind: "compact", text: summary }]);
        else if (message["status"] === "failed") {
          const detail = text(record(message["error"])["message"]);
          assistantTurn(message).parts.push({ kind: "text", text: `Error: compaction failed${detail.length > 0 ? `: ${detail}` : ""}` });
        }
        break;
      }
      case "assistant": {
        const turn = assistantTurn(message);
        let last: Extract<ConversationPart, { kind: "text" }> | null = null;
        (Array.isArray(message["content"]) ? message["content"] : []).forEach((value, index) => {
          const block = record(value);
          if (block["type"] === "text" && text(block["text"]).length > 0) {
            last = { kind: "text", text: text(block["text"]) };
            turn.parts.push(last);
          } else if (block["type"] === "reasoning" && text(block["text"]).length > 0) {
            turn.parts.push({ kind: "thinking", text: text(block["text"]) });
          } else if (block["type"] === "tool") {
            turn.parts.push(toolPart(id, index, block));
          }
        });
        const error = record(message["error"]);
        if (Object.keys(error).length > 0) {
          const detail = text(error["message"]);
          turn.parts.push({ kind: "text", text: error["type"] === "aborted" ? "Interrupted" : `Error: ${detail || text(error["type"])}` });
        }
        // an answer is the text the model ended on; a step that went on to call tools is commentary
        if (message["finish"] === "stop" && last !== null) (last as Extract<ConversationPart, { kind: "text" }>).phase = "final_answer";
        break;
      }
      // idle, agent/model/location switches, and kinds a later version adds: no turn of their own
    }
  }

  // a message with nothing to show (an empty step, a user turn of only an unknown file) is no turn
  const kept = turns.map((turn, index) => (turn.parts.length > 0 ? index : -1)).filter((index) => index >= 0);
  return { turns: kept.map((index) => turns[index]!), firstIds: kept.map((index) => firstIds[index]!) };
}

/** `provider/model`, the variant when it is not the default, and the context the newest request filled. */
export function opencodeMetadata(messages: readonly unknown[], windowOf: (providerID: string, modelID: string) => number | null = () => null): ConversationMetadata {
  const metadata: ConversationMetadata = { model: null, reasoning_effort: null };
  let modelSeen = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message["type"] !== "assistant") continue;
    const model = record(message["model"]);
    const modelID = text(model["id"]);
    const providerID = text(model["providerID"]);
    if (!modelSeen && modelID.length > 0) {
      modelSeen = true;
      metadata.model = providerID.length > 0 ? `${providerID}/${modelID}` : modelID;
      const variant = text(model["variant"]);
      metadata.reasoning_effort = variant.length > 0 && variant !== "default" ? variant : null;
    }
    // an errored or aborted step reports zeros: it filled nothing, so it says nothing of the context
    const tokens = record(message["tokens"]);
    const cache = record(tokens["cache"]);
    const used = count(tokens["input"]) + count(cache["read"]) + count(cache["write"]);
    if (used > 0) {
      metadata.context = { used, window: modelID.length > 0 ? windowOf(providerID, modelID) : null };
      break;
    }
  }
  return metadata;
}

/** A step with no end older than this was cut off (the server died), not written still. */
const STALE_MS = 10 * 60_000;

/**
 * Whether the end of the list is still being written: the newest assistant message has no end, a
 * tool has not finished, a shell command runs, or a compaction does (it changes in place, with no
 * new message and no change to the session).
 */
export function stillWriting(messages: readonly unknown[], now = Date.now()): boolean {
  const fresh = (message: Row): boolean => {
    const created = record(message["time"])["created"];
    return typeof created !== "number" || now - created < STALE_MS;
  };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message["type"] === "shell") return message["status"] === "running" && fresh(message);
    if (message["type"] === "compaction") return message["status"] === "running" && fresh(message);
    if (message["type"] !== "assistant") continue;
    if (!fresh(message)) return false;
    if (record(message["time"])["completed"] === undefined && Object.keys(record(message["error"])).length === 0) return true;
    return (Array.isArray(message["content"]) ? message["content"] : []).some((value) => {
      const status = record(record(value)["state"])["status"];
      return status === "streaming" || status === "running";
    });
  }
  return false;
}
