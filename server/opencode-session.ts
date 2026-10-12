/**
 * An OpenCode 2 pane's conversation, read through the CLI's own `opencode api` and never from
 * its database: the CLI finds the background service and signs in to it, so this process holds
 * no credential. A fleet pane runs `opencode --standalone`, a private server of its own, over the
 * same data directory as the service; the service reads the sessions that server wrote (the
 * database is shared), but its `/api/session/active` lists only what it runs itself, so whether
 * the pane is working comes from herdr's status instead.
 *
 * `opencode api` starts the service when none runs, which would launch the person's daemon from a
 * poll: `opencode service status` (a read) asks first, and a stopped service leaves the pane on
 * its scrollback.
 */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ConversationMetadata } from "../shared/protocol.ts";
import { ConversationUnavailable, HistoryChanged } from "./conversation-errors.ts";
import type { ConversationPage, RecognizedConversation } from "./conversation.ts";
import { herdrRpc } from "./herdr/client.ts";
import { OpencodeHttpError, opencodeCli, type OpencodeApi } from "./opencode-cli.ts";
import { OPENCODE_MESSAGE_ID, OPENCODE_REF, opencodeMetadata, parseOpencodeMessages, startsTurn, stillWriting, toolOutputOf } from "./opencode-messages.ts";
import { defaultStateDir } from "./state-dir.ts";
import { MAX_TURNS, record } from "./transcript-records.ts";

type Row = Record<string, unknown>;

/** `ses_` and letters and digits: the id herdr reports, checked before it reaches a URL */
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;

/** Messages asked of the CLI at a time, and how many a page holds at least (it also reaches back to a turn's start). */
const FETCH_MESSAGES = 100;
const PAGE_MESSAGES = 100;
/** A page holds no more messages than this: a longer turn is cut into pages, its newest steps first. */
const MAX_PAGE_MESSAGES = 300;
/** The messages kept of a session between polls; a poll reads the newest hundred and joins them to these. */
const KEEP_MESSAGES = 400;
/** Reads one walk makes at most: a gap or a revert deeper than this is a changed history, not a longer wait. */
const MAX_FETCHES = 15;
const SESSIONS_KEPT = 4;
const MODEL_TTL_MS = 10 * 60_000;
const MODEL_RETRY_MS = 30_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

/** The bytes of a pasted image are not kept: the chat asks for one by ref (`image`), and a page of them is megabytes. */
function slim(message: Row): Row {
  if (message["type"] !== "user" || !Array.isArray(message["files"])) return message;
  return { ...message, files: message["files"].map((file) => ({ ...record(file), data: "" })) };
}

/** What the walk back through a session's messages found. */
interface Walk {
  /** oldest first, what a staged revert hides left out */
  messages: Row[];
  /** the session's first message is among them */
  end: boolean;
  sinceFound: boolean;
  /** the staged revert's message was not reached: everything read is hidden by it */
  stillHidden: boolean;
  hidden: Set<string>;
  /** the newest message the service listed, hidden or not */
  newestId: string;
}

/** The newest messages of a session while it has not changed, and what says it has not. */
interface Newest { marker: string; messages: Row[]; end: boolean; hidden: Set<string>; revert: string | undefined; writing: boolean }

type Models = Map<string, number>;

/** Where a page starts in `messages`: at `since`; else at the first turn's start, and no more than a page back. */
function startOf(messages: readonly Row[], end: boolean, since: number): number {
  if (since >= 0) return since;
  let start = end ? 0 : Math.max(messages.findIndex(startsTurn), 0);
  const floor = messages.length - MAX_PAGE_MESSAGES;
  if (start < floor) {
    const turn = messages.findIndex((message, index) => index >= floor && startsTurn(message));
    start = turn >= 0 ? turn : floor;
  }
  return start;
}

/** The sessions read, what is kept of them, and the one place the CLI is called from. */
export class OpencodeConversations {
  private readonly newest = new Map<string, Newest>();
  private readonly reading = new Map<string, Promise<RecognizedConversation>>();
  private models: { at: number; windows: Models } | null = null;
  private loadingModels: Promise<Models> | null = null;
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

  /**
   * The newest message's id. A shell command, a compaction, a skill and a synthetic message are
   * written without the session's `time.updated` moving, so the session alone does not say that
   * the messages changed; a new message does change this.
   */
  private async newestId(sessionId: string): Promise<string> {
    const body = record(await this.api.get(`/api/session/${encoded(sessionId)}/message?limit=1&order=desc`));
    const first = record(Array.isArray(body["data"]) ? body["data"][0] : undefined);
    return typeof first["id"] === "string" ? first["id"] : "";
  }

  /** `provider\0model` -> context window, from the service's model list; empty when it cannot be read. */
  private windows(): Promise<Models> {
    const now = Date.now();
    if (this.models !== null && now - this.models.at < (this.models.windows.size > 0 ? MODEL_TTL_MS : MODEL_RETRY_MS)) return Promise.resolve(this.models.windows);
    this.loadingModels ??= (async () => {
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
      this.models = { at: Date.now(), windows };
      return windows;
    })().finally(() => { this.loadingModels = null; });
    return this.loadingModels;
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

    let messages: readonly Row[];
    let start: number;
    let end: boolean;
    if (page.before !== undefined) {
      if (page.since === page.before) return this.answer(sessionId, page, [], page.since, { model: null, reasoning_effort: null });
      // a `since` the service does not have is a changed history at once, not after the whole walk
      if (page.since !== undefined && (await this.message(sessionId, page.since)) === null) throw new HistoryChanged();
      const walk = await this.walk(sessionId, { before: page.before, since: page.since, revert });
      if (page.since !== undefined && !walk.sinceFound) throw new HistoryChanged();
      messages = walk.messages;
      end = walk.end;
      start = startOf(messages, end, page.since === undefined ? -1 : messages.findIndex((message) => message["id"] === page.since));
      // the anchor's own messages are not among them: an anchor the service no longer has
      // (a committed revert) answers an empty page, the same as the first message of a session
      if (messages.length === 0 && (await this.message(sessionId, page.before)) === null) throw new HistoryChanged();
    } else {
      const entry = await this.newestOf(sessionId, session, revert, working);
      messages = entry.messages;
      end = entry.end;
      start = startOf(messages, end, -1);
      if (page.from !== undefined) {
        const held = messages.findIndex((message) => message["id"] === page.from);
        if (held >= 0) start = Math.max(start, held);
        // not in the newest page: the page has moved past it, unless the service has lost it
        else if (entry.hidden.has(page.from) || (await this.message(sessionId, page.from)) === null) throw new HistoryChanged();
      }
    }

    const parsed = parseOpencodeMessages(messages.slice(start));
    const turns = parsed.turns.slice(-MAX_TURNS);
    const firstIds = parsed.firstIds.slice(-MAX_TURNS);
    // the beginning of the session: nothing before the first message, and no turn dropped
    const atBeginning = end && start === 0 && turns.length === parsed.turns.length;
    const cursor = atBeginning ? null : firstIds[0] ?? null;
    const windows = page.before === undefined ? await this.windows() : new Map<string, number>();
    const metadata = opencodeMetadata(messages, (provider, model) => windows.get(`${provider}\0${model}`) ?? null);
    return this.answer(sessionId, page, turns, cursor, metadata);
  }

  /**
   * The newest messages: kept while nothing says the session changed; else the newest page read
   * and joined to the older messages already held (a long turn is not walked again from its
   * start), or walked afresh when the two do not meet.
   */
  private async newestOf(sessionId: string, session: Row, revert: string | undefined, working: boolean): Promise<Newest> {
    const base = marks(session);
    const cached = this.newest.get(sessionId);
    if (cached !== undefined && !working && !cached.writing && cached.revert === revert && cached.marker === `${base}:${await this.newestId(sessionId)}`) return cached;
    const entry = await this.refresh(sessionId, base, revert, cached);
    this.newest.delete(sessionId);
    this.newest.set(sessionId, entry);
    if (this.newest.size > SESSIONS_KEPT) this.newest.delete(this.newest.keys().next().value!);
    return entry;
  }

  private async refresh(sessionId: string, base: string, revert: string | undefined, cached: Newest | undefined): Promise<Newest> {
    const settle = (messages: Row[], end: boolean, hidden: Set<string>, newestId: string): Newest => {
      const kept = messages.length > KEEP_MESSAGES;
      return { marker: `${base}:${newestId}`, messages: kept ? messages.slice(-KEEP_MESSAGES) : messages, end: end && !kept, hidden, revert, writing: stillWriting(messages, this.now()) };
    };
    if (cached !== undefined && revert === undefined && cached.revert === undefined) {
      const body = record(await this.api.get(`/api/session/${encoded(sessionId)}/message?limit=${FETCH_MESSAGES}&order=desc`));
      const data = (Array.isArray(body["data"]) ? body["data"] : []).map((value) => slim(record(value))).reverse();
      const newestId = typeof data.at(-1)?.["id"] === "string" ? data.at(-1)!["id"] as string : "";
      if (data.length < FETCH_MESSAGES) return settle(data, true, new Set(), newestId);
      const join = cached.messages.findIndex((message) => message["id"] === data[0]!["id"]);
      if (join >= 0) return settle([...cached.messages.slice(0, join), ...data], cached.end, new Set(), newestId);
    }
    const walk = await this.walk(sessionId, { revert });
    if (walk.stillHidden && !walk.end) throw new ConversationUnavailable("opencode_revert_too_deep");
    return settle(walk.messages, walk.end, walk.hidden, walk.newestId);
  }

  private answer(sessionId: string, page: ConversationPage, turns: RecognizedConversation["turns"], cursor: string | null, metadata: ConversationMetadata): RecognizedConversation {
    const version = createHash("sha256")
      .update(`${this.processVersion}\0${sessionId}\0${JSON.stringify(page)}\0${JSON.stringify({ turns, cursor, metadata })}`)
      .digest("base64url").slice(0, 22);
    return { source: "opencode-session", turns, metadata, cursor, history_id: sessionId, version };
  }

  /**
   * Messages from the newest (or from the ones older than `before`) back until a page's worth
   * with a turn's start among them, or the session begins. With `since` it goes on until that
   * message is reached: the page between is what the chat is missing. The list is newest first
   * and its cursor names a message, not a place, so a session that grows while this reads does
   * not shift the pages.
   */
  private async walk(sessionId: string, options: { before?: string; since?: string; revert?: string }): Promise<Walk> {
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
    let newestId = "";
    for (let fetched = 1; ; fetched += 1) {
      const path = `/api/session/${encoded(sessionId)}/message?limit=${FETCH_MESSAGES}${cursor === undefined ? "&order=desc" : `&cursor=${encoded(cursor)}`}`;
      let body: Row;
      try { body = record(await this.api.get(path)); } catch (error) {
        if (error instanceof OpencodeHttpError && error.status === 400 && cursor !== undefined) throw new HistoryChanged();
        throw error;
      }
      const data = Array.isArray(body["data"]) ? body["data"] : [];
      if (fetched === 1 && cursor === undefined) newestId = typeof record(data[0])["id"] === "string" ? record(data[0])["id"] as string : "";
      for (const value of data) {
        const message = slim(record(value));
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
      if (options.since !== undefined) { if (sinceFound) break; }
      else if (collected.length >= MAX_PAGE_MESSAGES || (collected.length >= PAGE_MESSAGES && collected.some(startsTurn))) break;
      if (fetched >= MAX_FETCHES) break;
      cursor = next;
    }
    return { messages: collected.reverse(), end, sinceFound, stillHidden: reverting, hidden, newestId };
  }

  /**
   * A staged revert hides its own message and every later one: an anchor among them is gone from
   * the history. Which is later is read from the times the service stamps, which only grow along
   * the list; two stamped alike are taken as not hidden, and the next read corrects it.
   */
  private async requireVisible(sessionId: string, revert: string, anchor: string): Promise<void> {
    if (anchor === revert) throw new HistoryChanged();
    const [reverted, held] = await Promise.all([this.message(sessionId, revert), this.message(sessionId, anchor)]);
    if (held === null) throw new HistoryChanged();
    if (reverted === null) return;
    const created = (message: Row): number => { const at = record(message["time"])["created"]; return typeof at === "number" ? at : 0; };
    if (created(held) > created(reverted)) throw new HistoryChanged();
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
