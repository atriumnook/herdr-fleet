import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type { ConversationTurn, HerdrPane } from "../shared/protocol.ts";
import type { SideChatSnapshot } from "../shared/side-chat.ts";
import { claudeEnv } from "./cli-child.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { parseClaudeTranscript } from "./conversation.ts";
import { conversationContext, screenContext } from "./side-chat-context.ts";

/**
 * Side chats: a question asked beside a pane's conversation, as Claude Code's desktop app asks one.
 * Each is a `claude -p` process of the server's, in stream-json both ways, that keeps no session
 * on disk and ends when the person closes it or the server stops. On a Claude pane it goes on from
 * a copy of the pane's own session (`--resume <id> --fork-session`): it knows everything said up to
 * that point and adds nothing back to it. On any other pane it is handed the pane's conversation,
 * or its screen, as text. Print mode asks no trust question (the folder is the pane's own). Claude
 * Code's auto mode judges its commands, as for the fleet's other Claude roles, and a hook refuses
 * every file edit; both leave the tools and the instructions as the pane's session had them, so a
 * fork reads the session from the prompt cache.
 */

/** How a side chat starts: from the pane's Claude session, or handed its conversation as text. */
export type SideChatPlan =
  | { kind: "fork"; cwd: string; session: string; model: string | null }
  | { kind: "context"; cwd: string; context: string };

/** A running `claude -p`, as the side chats use it (Bun.spawn's, or a test's). */
export interface SideChatProcess {
  write(line: string): void;
  lines: AsyncIterable<string>;
  stderr: Promise<string>;
  exited: Promise<number>;
  kill(): void;
}

export interface SideChatDeps {
  plan(paneId: string): Promise<SideChatPlan>;
  spawn?(argv: string[], cwd: string): SideChatProcess;
  /** the Claude Code executable */
  command?: string;
}

export class SideChatError extends Error {
  constructor(readonly code: "pane_not_found" | "pane_without_folder" | "side_chat_not_found" | "side_chat_ended" | "side_chat_busy" | "missing_text", message: string) {
    super(message);
  }
}

/** side chats with a process at once: each is a claude process on the person's plan */
export const MAX_SIDE_CHATS = 4;
/** how often a reply's text, as it comes, goes to the page */
const STREAM_PUSH_MS = 80;
const STDERR_CHARS = 2000;

/** a hook's whole answer to a file edit: refused, with the reason Claude reads */
const READ_ONLY_SETTINGS = {
  hooks: {
    PreToolUse: [{
      matcher: "Edit|MultiEdit|Write|NotebookEdit",
      hooks: [{ type: "command", command: "echo 'A side chat changes no file: write the change in your answer instead.' >&2; exit 2" }],
    }],
  },
};

const RULES = [
  "Answer from that conversation and from the code in this folder, and name the files and lines you rely on.",
  "Change nothing: edit no file, and run only commands that change nothing.",
  "Do not take up the conversation's work, and never type into another agent's pane or message it. When the person wants to tell that agent something, write the message for them to send.",
  "Answer briefly: the person reads you beside the other conversation.",
].join(" ");

/** The first message of a side chat that goes on from the pane's session: its question, and what it is. */
export function forkPrompt(question: string): string {
  return `[Side chat] The person opened a side chat on the conversation above to ask a question apart from it. That conversation goes on without you, and nothing you say here goes back into it. ${RULES}\n\nQuestion:\n${question}`;
}

/** The first message of a side chat handed the pane's conversation: the conversation, then its question. */
export function contextPrompt(context: string, question: string): string {
  return `[Side chat] The person opened a side chat to ask a question apart from another agent's conversation with them, which goes on without you. Below is that conversation (or the agent's screen) as it stood when they opened this side chat. ${RULES}\n\n${context}\nQuestion:\n${question}`;
}

/** The argv of a side chat's process. */
export function sideChatArgv(plan: SideChatPlan, command = "claude"): string[] {
  return [
    command, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--no-session-persistence", "--permission-mode", "auto", "--settings", JSON.stringify(READ_ONLY_SETTINGS),
    // the pane's own folder's project settings are the session's: a pane that had no Claude session gets the person's only
    ...(plan.kind === "fork"
      ? ["--resume", plan.session, "--fork-session", ...(plan.model ? ["--model", plan.model] : [])]
      : ["--setting-sources", "user"]),
  ];
}

/** What a side chat reads of herdr and the files to plan one (the server's own, or a test's). */
export interface SideChatPlanIo {
  pane(paneId: string): Promise<HerdrPane | undefined>;
  /** the Claude session herdr names for the pane, if any */
  claudeSession(paneId: string): Promise<string | null>;
  transcriptFile(session: string, cwds: (string | null | undefined)[]): Promise<string | null>;
  /** the start and the end of a transcript, as lines (a long one is not read whole) */
  transcriptEnds(path: string): Promise<string>;
  /** the pane's conversation; none when it keeps none */
  conversation(paneId: string): Promise<ConversationTurn[]>;
  screen(paneId: string): Promise<string>;
}

/**
 * Where a Claude session was started and the model it last answered with, read from its
 * transcript's lines: `--resume` finds a session in the project of the folder it starts in.
 */
export function sessionPlace(lines: string, projectDir: string, cwds: (string | null | undefined)[]): { cwd: string | null; model: string | null } {
  const seen: string[] = [];
  let model: string | null = null;
  for (const line of lines.split("\n")) {
    let entry: { cwd?: unknown; type?: unknown; message?: { model?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.cwd === "string" && !seen.includes(entry.cwd)) seen.push(entry.cwd);
    // a synthetic reply (an error, an interruption) names `<synthetic>`
    if (entry.type === "assistant" && typeof entry.message?.model === "string" && !entry.message.model.startsWith("<")) model = entry.message.model;
  }
  const cwd = [...seen, ...cwds].find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0 && claudeProjectDir(candidate) === projectDir) ?? null;
  return { cwd, model };
}

/** How to start a side chat about a pane: from its Claude session when it has one, else from its conversation or screen. */
export async function sideChatPlan(paneId: string, io: SideChatPlanIo): Promise<SideChatPlan> {
  const pane = await io.pane(paneId);
  if (!pane) throw new SideChatError("pane_not_found", `herdr knows no pane ${paneId}.`);
  const agent = pane.agent ?? pane.agent_session?.agent ?? null;
  if (agent === "claude") {
    const session = await io.claudeSession(paneId);
    const path = session === null ? null : await io.transcriptFile(session, [pane.cwd, pane.foreground_cwd]);
    if (session !== null && path !== null) {
      const { cwd, model } = sessionPlace(await io.transcriptEnds(path), basename(dirname(path)), [pane.cwd, pane.foreground_cwd]);
      if (cwd !== null) return { kind: "fork", cwd, session, model };
    }
  }
  const cwd = pane.cwd ?? pane.foreground_cwd;
  if (!cwd) throw new SideChatError("pane_without_folder", `herdr knows no folder for pane ${paneId}.`);
  const described = { title: pane.label?.trim() || pane.title?.trim() || pane.terminal_title_stripped?.trim() || pane.pane_id, agent, cwd };
  const turns = await io.conversation(paneId);
  return { kind: "context", cwd, context: turns.length > 0 ? conversationContext(described, turns) : screenContext(described, await io.screen(paneId)) };
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = rest.indexOf("\n")) >= 0) {
      yield rest.slice(0, end);
      rest = rest.slice(end + 1);
    }
  }
  if (rest.trim()) yield rest;
}

/** `claude -p` with the person's sign-in and nothing else of the server's environment (cli-child.ts). */
function spawnClaude(argv: string[], cwd: string): SideChatProcess {
  const child = Bun.spawn(argv, { cwd, env: claudeEnv(process.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    write: (line) => {
      try { child.stdin.write(line); child.stdin.flush(); } catch { /* it ended: its exit says so */ }
    },
    lines: readLines(child.stdout),
    stderr: new Response(child.stderr).text(),
    exited: child.exited,
    kill: () => {
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2000).unref();
    },
  };
}

interface Live {
  chat: SideChatSnapshot;
  process: SideChatProcess;
  /** the conversation as transcript lines, for the transcript reader */
  lines: string[];
  closed: boolean;
  interrupting: boolean;
  /** questions sent that no result has answered yet: one sent mid-turn waits for the turn before */
  waiting: number;
  /** when it was last asked or answered, for the one to end when too many are open */
  used: number;
  pushTimer: ReturnType<typeof setTimeout> | null;
}

/** The server's side chats, one per pane, kept in memory only. */
export class SideChats {
  private readonly chats = new Map<string, Live>();
  private readonly byPane = new Map<string, string>();
  private readonly watchers = new Map<string, Set<(chat: SideChatSnapshot | null) => void>>();
  /** the starts under way, by pane: a second start waits for the first, then replaces it */
  private readonly starts = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SideChatDeps) {}

  /** A new side chat about a pane, asked its first question; one the pane had before ends. */
  async start(paneId: string, text: string): Promise<SideChatSnapshot> {
    if (!text.trim()) throw new SideChatError("missing_text", "Write a question.");
    const previous = this.starts.get(paneId) ?? Promise.resolve();
    const started = previous.catch(() => {}).then(() => this.open(paneId, text));
    this.starts.set(paneId, started);
    try {
      return await started;
    } finally {
      if (this.starts.get(paneId) === started) this.starts.delete(paneId);
    }
  }

  private async open(paneId: string, text: string): Promise<SideChatSnapshot> {
    const plan = await this.deps.plan(paneId);
    const before = this.byPane.get(paneId);
    // the pane's own goes for the new one: it is no other's room to take
    const open = [...this.chats.values()].filter((live) => live.chat.status !== "ended" && live.chat.id !== before);
    let room: Live | undefined;
    if (open.length >= MAX_SIDE_CHATS) {
      room = open.filter((live) => live.chat.status === "idle").sort((a, b) => a.used - b.used)[0];
      if (!room) throw new SideChatError("side_chat_busy", `${MAX_SIDE_CHATS} side chats are answering. Wait for one, or close one.`);
    }
    // the side chats there stay until the new one has its process: a start that fails ends nothing
    const process = (this.deps.spawn ?? spawnClaude)(sideChatArgv(plan, this.deps.command), plan.cwd);
    if (room) this.end(room);
    if (before !== undefined) this.close(before, false);
    const live: Live = {
      chat: { id: randomUUID().slice(0, 8), paneId, source: plan.kind, status: "working", turns: [], streaming: "", error: null },
      process, lines: [], closed: false, interrupting: false, waiting: 0, used: Date.now(), pushTimer: null,
    };
    this.chats.set(live.chat.id, live);
    this.byPane.set(paneId, live.chat.id);
    void this.follow(live);
    this.ask(live, text, plan.kind === "fork" ? forkPrompt(text) : contextPrompt(plan.context, text));
    return live.chat;
  }

  /** The person's next question in an open side chat; Claude takes it after the turn it is in. */
  send(id: string, text: string): SideChatSnapshot {
    const live = this.live(id);
    if (!text.trim()) throw new SideChatError("missing_text", "Write a question.");
    this.ask(live, text, text);
    return live.chat;
  }

  /** Stops the turn under way; the side chat stays open. */
  interrupt(id: string): SideChatSnapshot {
    const live = this.live(id);
    if (live.chat.status === "working") {
      live.interrupting = true;
      live.process.write(`${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`);
    }
    return live.chat;
  }

  /** Ends a side chat and forgets it: nothing of it is kept. */
  close(id: string, tell = true): void {
    const live = this.chats.get(id);
    if (!live) throw new SideChatError("side_chat_not_found", "That side chat is gone.");
    live.closed = true;
    this.end(live);
    this.chats.delete(id);
    if (this.byPane.get(live.chat.paneId) === id) this.byPane.delete(live.chat.paneId);
    if (tell) this.tell(live.chat.paneId, null);
  }

  /** The pane's side chat, ended or not; null when it has none. */
  current(paneId: string): SideChatSnapshot | null {
    const id = this.byPane.get(paneId);
    return id === undefined ? null : this.chats.get(id)?.chat ?? null;
  }

  /** Calls `listener` with the pane's side chat now and after each change. */
  watch(paneId: string, listener: (chat: SideChatSnapshot | null) => void): () => void {
    let set = this.watchers.get(paneId);
    if (!set) this.watchers.set(paneId, set = new Set());
    set.add(listener);
    listener(this.current(paneId));
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.watchers.get(paneId) === set) this.watchers.delete(paneId);
    };
  }

  /** Ends every side chat's process (the server stops). */
  stop(): void {
    for (const live of this.chats.values()) { live.closed = true; this.end(live); }
  }

  private live(id: string): Live {
    const live = this.chats.get(id);
    if (!live) throw new SideChatError("side_chat_not_found", "That side chat is gone.");
    if (live.chat.status === "ended") throw new SideChatError("side_chat_ended", "This side chat has ended. Start a new one.");
    return live;
  }

  private ask(live: Live, shown: string, sent: string): void {
    live.used = Date.now();
    live.waiting += 1;
    // a stop asked for the turn before is no stop of this one
    live.interrupting = false;
    this.record(live, { type: "user", message: { role: "user", content: shown } });
    live.chat = { ...live.chat, status: "working", error: null };
    live.process.write(`${JSON.stringify({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: sent }] } })}\n`);
    this.push(live);
  }

  private end(live: Live): void {
    if (live.pushTimer !== null) clearTimeout(live.pushTimer);
    live.pushTimer = null;
    if (live.chat.status !== "ended") live.process.kill();
    live.chat = { ...live.chat, status: "ended", streaming: "" };
  }

  /** a message in the transcript's own form, timed now */
  private record(live: Live, entry: Record<string, unknown>): void {
    live.lines.push(JSON.stringify({ ...entry, timestamp: new Date().toISOString() }));
    live.chat = { ...live.chat, turns: parseClaudeTranscript(live.lines.join("\n")) };
  }

  /** Reads the process's events until it exits. */
  private async follow(live: Live): Promise<void> {
    try {
      for await (const line of live.process.lines) {
        if (live.closed) break;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line); } catch { continue; }
        this.take(live, event);
      }
    } catch { /* its exit says what happened */ }
    const code = await live.process.exited;
    if (live.closed) return;
    // ended here to make room for another: its exit is no failure
    if (live.chat.status === "ended") { this.push(live); return; }
    const stderr = (await live.process.stderr.catch(() => "")).trim();
    const error = live.chat.error ?? (code === 0 ? null : stderr.slice(-STDERR_CHARS) || `Claude Code stopped (exit ${code}).`);
    live.chat = { ...live.chat, status: "ended", streaming: "", error };
    this.push(live);
  }

  private take(live: Live, event: Record<string, unknown>): void {
    // a question sent mid-turn is answered after it: its reply is a turn under way again
    const working = live.chat.status === "ended" ? "ended" : "working";
    switch (event["type"]) {
      case "stream_event": {
        const inner = event["event"] as { type?: string; delta?: { type?: string; text?: unknown } } | undefined;
        if (inner?.type === "message_start") live.chat = { ...live.chat, status: working, streaming: "" };
        else if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
          live.chat = { ...live.chat, streaming: live.chat.streaming + inner.delta.text };
          this.pushSoon(live);
        }
        return;
      }
      case "assistant":
      case "user":
        // a whole message: its text is in the turns now
        if (event["type"] === "assistant") live.chat = { ...live.chat, status: working, streaming: "" };
        this.record(live, { type: event["type"], message: event["message"] });
        this.push(live);
        return;
      case "result": {
        live.used = Date.now();
        // an interruption ends the turn with an error of its own: the person asked for it
        const failed = event["is_error"] === true && !live.interrupting;
        const error = failed ? (typeof event["result"] === "string" && event["result"] ? event["result"] : String(event["subtype"] ?? "error")) : null;
        live.interrupting = false;
        live.waiting = Math.max(0, live.waiting - 1);
        // an ended one stays ended: its process is going
        const status = live.chat.status === "ended" ? "ended" : live.waiting > 0 ? "working" : "idle";
        live.chat = { ...live.chat, status, streaming: "", error };
        this.push(live);
        return;
      }
    }
  }

  private pushSoon(live: Live): void {
    if (live.pushTimer !== null) return;
    live.pushTimer = setTimeout(() => this.push(live), STREAM_PUSH_MS);
  }

  private push(live: Live): void {
    if (live.pushTimer !== null) clearTimeout(live.pushTimer);
    live.pushTimer = null;
    if (this.byPane.get(live.chat.paneId) === live.chat.id) this.tell(live.chat.paneId, live.chat);
  }

  private tell(paneId: string, chat: SideChatSnapshot | null): void {
    for (const listener of this.watchers.get(paneId) ?? []) listener(chat);
  }
}
