/**
 * An OpenCode 2 pane's conversation, read through the CLI's own `opencode2 api` and never from
 * its database: the CLI finds the background service and signs in to it, so this process holds
 * no credential. A fleet pane runs `opencode2 --standalone`, a private server of its own, over the
 * same data directory as the service; the service reads the sessions that server wrote (the
 * database is shared), but its `/api/session/active` lists only what it runs itself, so whether
 * the pane is working comes from herdr's status instead.
 *
 * `opencode2 api` starts the service when none runs, which would launch the person's daemon from a
 * poll: `opencode2 service status` (a read) asks first, and a stopped service leaves the pane on
 * its scrollback.
 */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ConversationMetadata } from "../shared/protocol.ts";
import { ConversationUnavailable, HistoryChanged } from "./conversation-errors.ts";
import type { ConversationPage, RecognizedConversation } from "./conversation.ts";
import { herdrRpc } from "./herdr/client.ts";
import { childEnv, emptyWorkDir } from "./cli-child.ts";
import { OPENCODE_MESSAGE_ID, OPENCODE_REF, opencodeMetadata, parseOpencodeMessages, startsTurn, stillWriting, toolOutputOf } from "./opencode-messages.ts";
import { defaultStateDir } from "./state-dir.ts";
import { MAX_TURNS, record } from "./transcript-records.ts";

type Row = Record<string, unknown>;

/** `ses_` and letters and digits: the id herdr reports, checked before it reaches a URL */
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;

/** Messages asked of the CLI at a time, and how many a page holds at least (it also reaches back to a turn's start). */
const FETCH_MESSAGES = 100;
const PAGE_MESSAGES = 100;
/** A session this long is read no further back in one page: the rest is a page of its own. */
const MAX_FETCHES = 30;
const CLI_TIMEOUT_MS = 20_000;
/** `opencode2 service status` is asked at most this often */
const SERVICE_TTL_MS = 2_000;
const MODEL_TTL_MS = 10 * 60_000;
const MODEL_RETRY_MS = 30_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The CLI answered with an HTTP error: `status` is its code, `tag` the body's `_tag`. */
export class OpencodeHttpError extends Error {
  constructor(readonly status: number, readonly tag: string) {
    super(`opencode api answered ${status}${tag ? ` ${tag}` : ""}`);
    this.name = "OpencodeHttpError";
  }
}

export interface OpencodeApi {
  /** the parsed JSON body of a GET; throws OpencodeHttpError for an HTTP error, Error for a read that failed */
  get(path: string): Promise<unknown>;
  /** whether the background service answers; never starts it */
  serviceRunning(): Promise<boolean>;
}

export interface CliOptions {
  /** the CLI's own folder; the CLI runs nowhere else */
  workDir: string;
  command?: string;
  /** the server's environment; process.env when left out */
  env?: Record<string, string | undefined>;
  /** how often a cut reply is read again */
  attempts?: number;
}

/**
 * `opencode2 api GET <path>` and `opencode2 service status`, run as a usage probe is: in a folder
 * of ours, with only the environment the CLI needs to find its service (HOME, XDG_*).
 *
 * The CLI writes its reply and exits without waiting for the pipe to drain, so a large reply to a
 * pipe can arrive cut (seen with Python's pipes; Bun's reads whole). A cut reply is not JSON: it
 * is read again rather than taken for an answer.
 */
export function opencodeCli(options: CliOptions): OpencodeApi {
  const command = options.command ?? "opencode2";
  const attempts = options.attempts ?? 3;
  let prepared = false;
  let service: { at: number; running: boolean } | null = null;

  async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    // once: a second read must not empty the folder under a first one still running
    if (!prepared) { emptyWorkDir(options.workDir); prepared = true; }
    const child = Bun.spawn([command, ...args], { cwd: options.workDir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv(options.env ?? process.env) });
    const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
    try {
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { stdout, stderr, code: await child.exited };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get(path) {
      for (let attempt = 1; ; attempt += 1) {
        const { stdout, stderr, code } = await run(["api", "GET", path]);
        let body: unknown;
        try { body = JSON.parse(stdout); } catch {
          if (attempt < attempts) continue;
          throw new Error("opencode api returned no JSON");
        }
        if (code === 0) return body;
        const status = /HTTP (\d{3})/.exec(stderr)?.[1];
        throw new OpencodeHttpError(status === undefined ? 0 : Number(status), String(record(body)["_tag"] ?? ""));
      }
    },
    async serviceRunning() {
      const now = Date.now();
      if (service !== null && now - service.at < SERVICE_TTL_MS) return service.running;
      let running = false;
      try {
        const { stdout, code } = await run(["service", "status"]);
        running = code === 0 && /^https?:\/\//.test(stdout.trim());
      } catch { /* a status that cannot be asked is a service not known to run */ }
      service = { at: now, running };
      return running;
    },
  };
}

/** The pane's OpenCode session id, or null when herdr reports none (or one of another form). */
export async function opencodeSessionId(paneId: string): Promise<string | null> {
  const info = await herdrRpc<{ agent: { agent_session?: { agent?: unknown; kind?: unknown; value?: unknown } } }>(
    "agent.get",
    { target: paneId },
  ).catch(() => null);
  const session = info?.agent?.agent_session;
  if (session?.kind !== "id" || typeof session.value !== "string") return null;
  return OPENCODE_SESSION_ID.test(session.value) ? session.value : null;
}

const encoded = (value: string): string => encodeURIComponent(value);

/** What the walk back through a session's messages found. */
interface Walk {
  /** oldest first, what a staged revert hides left out */
  messages: Row[];
  /** the session's first message is among them */
  end: boolean;
  /** where the page starts in `messages`: at `since`, else at the first turn's start; the session's own beginning keeps all */
  start: number;
  sinceFound: boolean;
  hidden: Set<string>;
}

interface Newest { marker: string; walk: Walk; writing: boolean }

type Models = Map<string, number>;

/** The sessions read, what is kept of them, and the one place the CLI is called from. */
export class OpencodeConversations {
  /** the newest page's messages while the session has not changed */
  private readonly newest = new Map<string, Newest>();
  private readonly reading = new Map<string, Promise<RecognizedConversation>>();
  private models: { at: number; windows: Models } | null = null;
  private readonly processVersion = randomUUID();

  constructor(private readonly api: OpencodeApi, private readonly now: () => number = Date.now) {}

  /**
   * One page, as paneConversation says: the newest without `before`, with `from` kept while it is
   * inside it. `working` is herdr's word that the pane is busy. Reads for one page of one session
   * share a call, so two panels polling it cost one.
   */
  page(sessionId: string, working: boolean, page: ConversationPage = {}): Promise<RecognizedConversation> {
    const key = [sessionId, page.before ?? "", page.since ?? "", page.from ?? "", working].join("\0");
    const inflight = this.reading.get(key);
    if (inflight !== undefined) return inflight;
    const read = this.read(sessionId, working, page).finally(() => this.reading.delete(key));
    this.reading.set(key, read);
    return read;
  }

  /** A tool call's whole output, by the ref a cut output carries; null when there is none. */
  async toolOutput(sessionId: string, ref: string): Promise<string | null> {
    const match = OPENCODE_REF.exec(ref);
    if (match === null) return null;
    const message = await this.message(sessionId, match[1]!);
    return message === null ? null : toolOutputOf(message, Number(match[2]));
  }

  /** A user image, decoded, by the ref its part carries; null when there is none. */
  async image(sessionId: string, ref: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
    const match = OPENCODE_REF.exec(ref);
    if (match === null) return null;
    const message = record(await this.message(sessionId, match[1]!));
    if (message["type"] !== "user") return null;
    const file = record(Array.isArray(message["files"]) ? message["files"][Number(match[2])] : undefined);
    const mime = typeof file["mime"] === "string" ? file["mime"] : "";
    if (!IMAGE_TYPES.has(mime) || typeof file["data"] !== "string") return null;
    return { mediaType: mime, bytes: new Uint8Array(Buffer.from(file["data"], "base64")) };
  }

  private async message(sessionId: string, messageId: string): Promise<Row | null> {
    await this.requireService();
    try {
      return record(record(await this.api.get(`/api/session/${encoded(sessionId)}/message/${encoded(messageId)}`))["data"]);
    } catch (error) {
      if (error instanceof OpencodeHttpError && error.status === 404) return null;
      throw error;
    }
  }

  private async requireService(): Promise<void> {
    if (!await this.api.serviceRunning()) throw new ConversationUnavailable("opencode_service_stopped");
  }

  /** What the CLI says of the session itself; null when there is no such session. */
  private async session(sessionId: string): Promise<Row | null> {
    try {
      return record(record(await this.api.get(`/api/session/${encoded(sessionId)}`))["data"]);
    } catch (error) {
      if (error instanceof OpencodeHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /** `provider\0model` -> context window, from the service's model list; empty when it cannot be read. */
  private async windows(): Promise<Models> {
    const now = Date.now();
    if (this.models !== null && now - this.models.at < (this.models.windows.size > 0 ? MODEL_TTL_MS : MODEL_RETRY_MS)) return this.models.windows;
    const windows: Models = new Map();
    try {
      const body = record(await this.api.get("/api/model"));
      for (const value of Array.isArray(body["data"]) ? body["data"] : []) {
        const model = record(value);
        const context = record(model["limit"])["context"];
        if (typeof context !== "number" || typeof model["providerID"] !== "string") continue;
        for (const id of [model["modelID"], model["id"]]) if (typeof id === "string") windows.set(`${model["providerID"]}\0${id}`, context);
      }
    } catch { /* no window is drawn rather than a guessed one */ }
    this.models = { at: now, windows };
    return windows;
  }

  private async read(sessionId: string, working: boolean, page: ConversationPage): Promise<RecognizedConversation> {
    await this.requireService();
    const anchored = page.before !== undefined || page.since !== undefined || page.from !== undefined;
    for (const cursor of [page.before, page.since, page.from]) if (cursor !== undefined && !OPENCODE_MESSAGE_ID.test(cursor)) throw new HistoryChanged();
    const session = await this.session(sessionId);
    if (session === null) {
      if (anchored) throw new HistoryChanged();
      throw new ConversationUnavailable("opencode_session_missing");
    }
    const revert = typeof record(session["revert"])["messageID"] === "string" ? record(session["revert"])["messageID"] as string : undefined;
    const marker = marks(session);

    let messages: Row[];
    let start: number;
    let end: boolean;
    if (page.before !== undefined) {
      if (page.since === page.before) return this.answer(sessionId, page, [], page.since, { model: null, reasoning_effort: null });
      const walk = await this.walk(sessionId, { before: page.before, since: page.since, revert, need: PAGE_MESSAGES });
      if (page.since !== undefined && !walk.sinceFound) throw new HistoryChanged();
      messages = walk.messages;
      end = walk.end;
      start = walk.start;
      // the anchor's own messages are not among them: an anchor the service no longer has
      // (a committed revert) answers an empty page, the same as the first message of a session
      if (messages.length === 0 && (await this.message(sessionId, page.before)) === null) throw new HistoryChanged();
    } else {
      const cached = this.newest.get(sessionId);
      let entry: Newest;
      if (cached !== undefined && cached.marker === marker && !working && !cached.writing) entry = cached;
      else {
        const walk = await this.walk(sessionId, { revert, need: PAGE_MESSAGES });
        entry = { marker, walk, writing: stillWriting(walk.messages, this.now()) };
        this.newest.delete(sessionId);
        this.newest.set(sessionId, entry);
        if (this.newest.size > 8) this.newest.delete(this.newest.keys().next().value!);
      }
      messages = entry.walk.messages;
      end = entry.walk.end;
      start = entry.walk.start;
      if (page.from !== undefined) {
        const held = messages.findIndex((message) => message["id"] === page.from);
        if (held >= 0) start = Math.max(start, held);
        // not in the newest page: the page has moved past it, unless the service has lost it
        else if (entry.walk.hidden.has(page.from) || (await this.message(sessionId, page.from)) === null) throw new HistoryChanged();
      }
    }

    const shown = messages.slice(start);
    const parsed = parseOpencodeMessages(shown);
    const turns = parsed.turns.slice(-MAX_TURNS);
    const firstIds = parsed.firstIds.slice(-MAX_TURNS);
    // the beginning of the session: nothing before the first message, and no turn dropped
    const atBeginning = end && start === 0 && turns.length === parsed.turns.length;
    const cursor = atBeginning ? null : firstIds[0] ?? null;
    const windows = page.before === undefined ? await this.windows() : new Map<string, number>();
    const metadata = opencodeMetadata(messages, (provider, model) => windows.get(`${provider}\0${model}`) ?? null);
    return this.answer(sessionId, page, turns, cursor, metadata);
  }

  private answer(sessionId: string, page: ConversationPage, turns: RecognizedConversation["turns"], cursor: string | null, metadata: ConversationMetadata): RecognizedConversation {
    const version = createHash("sha256")
      .update(`${this.processVersion}\0${sessionId}\0${JSON.stringify(page)}\0${JSON.stringify({ turns, cursor, metadata })}`)
      .digest("base64url").slice(0, 22);
    return { source: "opencode-session", turns, metadata, cursor, history_id: sessionId, version };
  }

  /**
   * Messages from the newest (or from the ones older than `before`) back until a page's worth
   * with a turn's start among them, `since` is reached, or the session begins. The list is newest
   * first and its cursor names a message, not a place, so a session that grows while this reads
   * does not shift the pages.
   */
  private async walk(sessionId: string, options: { before?: string; since?: string; revert?: string; need: number }): Promise<Walk> {
    const collected: Row[] = [];
    const hidden = new Set<string>();
    // the newest page starts above a staged revert's message and drops everything down to it
    let reverting = options.before === undefined && options.revert !== undefined;
    let cursor: string | undefined;
    if (options.before !== undefined) {
      // the cursor the list itself hands out for "older than this message"; the service refuses one it cannot read
      cursor = Buffer.from(JSON.stringify({ id: options.before, order: "desc", direction: "next" })).toString("base64url");
      if (options.revert !== undefined) await this.requireVisible(sessionId, options.revert, options.before);
    }
    let sinceFound = false;
    let end = false;
    for (let fetched = 1; ; fetched += 1) {
      const path = `/api/session/${encoded(sessionId)}/message?limit=${FETCH_MESSAGES}${cursor === undefined ? "&order=desc" : `&cursor=${encoded(cursor)}`}`;
      let body: Row;
      try { body = record(await this.api.get(path)); } catch (error) {
        if (error instanceof OpencodeHttpError && error.status === 400 && cursor !== undefined) throw new HistoryChanged();
        throw error;
      }
      const data = Array.isArray(body["data"]) ? body["data"] : [];
      for (const value of data) {
        const message = record(value);
        const id = typeof message["id"] === "string" ? message["id"] : "";
        if (reverting) {
          hidden.add(id);
          if (id === options.revert) reverting = false;
          continue;
        }
        collected.push(message);
        if (id === options.since) sinceFound = true;
      }
      const next = record(body["cursor"])["next"];
      // fewer than asked for is the last page
      if (data.length < FETCH_MESSAGES || typeof next !== "string") { end = true; break; }
      if (sinceFound) break;
      if (collected.length >= options.need && collected.some(startsTurn)) break;
      if (fetched >= MAX_FETCHES) break;
      cursor = next;
    }
    const messages = collected.reverse();
    const since = sinceFound ? messages.findIndex((message) => message["id"] === options.since) : -1;
    const turnStart = end ? 0 : messages.findIndex(startsTurn);
    return { messages, end, start: since >= 0 ? since : Math.max(turnStart, 0), sinceFound, hidden };
  }

  /** A staged revert hides its own message and every later one: an anchor among them is gone from the history. Times only grow along the list. */
  private async requireVisible(sessionId: string, revert: string, anchor: string): Promise<void> {
    const [reverted, held] = await Promise.all([this.message(sessionId, revert), this.message(sessionId, anchor)]);
    if (held === null) throw new HistoryChanged();
    if (reverted === null) return;
    const created = (message: Row): number => { const at = record(message["time"])["created"]; return typeof at === "number" ? at : 0; };
    if (created(held) >= created(reverted)) throw new HistoryChanged();
  }
}

/** What a change to the session can touch: when it was written, when it went idle, what it used, where it was reverted to. */
function marks(session: Row): string {
  const time = record(session["time"]);
  const tokens = record(session["tokens"]);
  return [time["updated"], time["idle"], tokens["input"], tokens["output"], session["cost"], record(session["revert"])["messageID"]].join(":");
}

let shared: OpencodeConversations | undefined;
/** The server's one reader, on the real CLI. */
export function opencodeConversations(): OpencodeConversations {
  return shared ??= new OpencodeConversations(opencodeCli({ workDir: join(defaultStateDir(), "opencode-api") }));
}
