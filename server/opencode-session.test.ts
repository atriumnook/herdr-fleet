import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationTurn } from "../shared/protocol.ts";
import { ConversationUnavailable, HistoryChanged } from "./conversation-errors.ts";
import { parseOpencodeMessages } from "./opencode-messages.ts";
import { OpencodeConversations, OpencodeHttpError, opencodeCli, type CliOptions, type OpencodeApi } from "./opencode-session.ts";

type Row = Record<string, unknown>;
const SID = "ses_testsession0001";

/**
 * The service as the CLI shows it, in memory: a message list newest first with cursors that name a
 * message (not a place), a session, and the call log. Texts are placeholders.
 */
class Service implements OpencodeApi {
  messages: Row[] = [];
  session: Row | null = { id: SID, time: { created: 1, updated: 1 }, tokens: { input: 0, output: 0 }, cost: 0 };
  running = true;
  models: Row[] = [];
  calls: string[] = [];
  async serviceRunning(): Promise<boolean> { return this.running; }

  /** the message lists asked for, but the one-message look at the newest */
  get listCalls(): number { return this.calls.filter((path) => path.includes("/message?") && !path.includes("limit=1&")).length; }
  /** the one-message looks at the newest */
  get probes(): number { return this.calls.filter((path) => path.includes("limit=1&")).length; }

  touch(): void {
    const time = this.session!["time"] as { updated: number };
    time.updated += 1;
  }

  async get(path: string): Promise<unknown> {
    this.calls.push(path);
    const url = new URL(path, "http://service");
    if (url.pathname === "/api/model") return { data: this.models };
    const match = /^\/api\/session\/([^/]+)(?:\/message(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (match === null) throw new OpencodeHttpError(404, "NotFound");
    if (this.session === null || match[1] !== SID) throw new OpencodeHttpError(404, "SessionNotFoundError");
    if (!url.pathname.includes("/message")) return { data: this.session };
    if (match[2] !== undefined) {
      const found = this.messages.find((message) => message["id"] === match[2]);
      if (found === undefined) throw new OpencodeHttpError(404, "MessageNotFoundError");
      return { data: found };
    }
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const encoded = url.searchParams.get("cursor");
    let rows: Row[];
    if (encoded === null) rows = [...this.messages].reverse().slice(0, limit);
    else {
      if (url.searchParams.has("order")) throw new OpencodeHttpError(400, "InvalidCursorError");
      let cursor: { id?: string; order?: string; direction?: string };
      try { cursor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw new OpencodeHttpError(400, "InvalidCursorError"); }
      const at = this.messages.findIndex((message) => message["id"] === cursor.id);
      // an anchor the service no longer has answers an empty page, as the real one does
      rows = at < 0 || cursor.order !== "desc" || cursor.direction !== "next" ? [] : this.messages.slice(Math.max(0, at - limit), at).reverse();
    }
    const point = (row: Row | undefined, direction: string): string | undefined =>
      row === undefined ? undefined : Buffer.from(JSON.stringify({ id: row["id"], order: "desc", direction })).toString("base64url");
    return { data: rows, ...(rows.length === 0 ? {} : { cursor: { previous: point(rows[0], "previous"), next: point(rows[rows.length - 1], "next") } }) };
  }
}

let clock = 1;
const user = (id: string): Row => ({ id, type: "user", time: { created: clock++ }, text: `<${id}>` });
const step = (id: string, extra: Row = {}): Row => ({
  id, type: "assistant", agent: "build", model: { id: "model-x", providerID: "prov-x" }, time: { created: clock++, completed: clock }, finish: "tool-calls",
  tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 90, write: 0 } }, content: [{ type: "text", text: `<${id}>` }], ...extra,
});

/** `count` prompts, each answered by `steps` steps */
function chat(count: number, steps = 3): Row[] {
  const rows: Row[] = [];
  for (let turn = 0; turn < count; turn += 1) {
    rows.push(user(`msg_u${turn}`));
    for (let k = 0; k < steps; k += 1) rows.push(step(`msg_a${turn}_${k}`));
  }
  return rows;
}

const withService = (messages: Row[]): { service: Service; reader: OpencodeConversations } => {
  const service = new Service();
  service.messages = messages;
  return { service, reader: new OpencodeConversations(service, () => 100) };
};

/** every page back to the beginning, newest page last */
async function wholeConversation(reader: OpencodeConversations): Promise<ConversationTurn[]> {
  let page = await reader.page(SID, false);
  const pages = [page.turns];
  while (page.cursor !== null) {
    page = await reader.page(SID, false, { before: page.cursor });
    pages.unshift(page.turns);
  }
  return pages.flat();
}

describe("the newest page", () => {
  test("a short session is one page that begins at the beginning, read in two calls", async () => {
    const { service, reader } = withService(chat(3));
    const page = await reader.page(SID, false);
    expect(page.source).toBe("opencode-session");
    expect(page.history_id).toBe(SID);
    expect(page.cursor).toBeNull();
    expect(page.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(page.metadata).toEqual({ model: "prov-x/model-x", reasoning_effort: null, context: { used: 100, window: null } });
    // fewer messages than asked for are all of them: no second page to find that out
    expect(service.listCalls).toBe(1);
  });

  test("an empty session is no turns and no cursor", async () => {
    const { reader } = withService([]);
    const page = await reader.page(SID, false);
    expect(page.turns).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  test("a long session starts at a turn's start, and the pages before it join it exactly", async () => {
    const messages = chat(80, 3);
    const { reader } = withService(messages);
    const newest = await reader.page(SID, false);
    expect(newest.cursor).toMatch(/^msg_u\d+$/);
    expect(newest.turns[0]!.role).toBe("user");
    expect(await wholeConversation(reader)).toEqual(parseOpencodeMessages(messages).turns);
  });

  test("a turn longer than a page is cut into pages, its newest steps first, and the older ones join it exactly", async () => {
    const messages = [user("msg_first"), ...Array.from({ length: 700 }, (_, k) => step(`msg_s${k}`))];
    const { service, reader } = withService(messages);
    const page = await reader.page(SID, false);
    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]!.parts.length).toBeLessThanOrEqual(300);
    expect(page.cursor).toBe("msg_s400");
    expect(service.listCalls).toBeLessThanOrEqual(3);
    const steps = (turns: ConversationTurn[]): number => turns.flatMap((turn) => turn.parts).length;
    expect(steps(await wholeConversation(reader))).toBe(steps(parseOpencodeMessages(messages).turns));
  });

  test("a turn longer than a fetch is read whole, back to the prompt that began it", async () => {
    const messages = [user("msg_first"), ...Array.from({ length: 250 }, (_, k) => step(`msg_s${k}`))];
    const { reader } = withService(messages);
    const page = await reader.page(SID, false);
    expect(page.cursor).toBeNull();
    expect(page.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(page.turns[1]!.parts).toHaveLength(250);
  });

  test("more turns than a page holds keep the newest, and the cursor names the first one kept", async () => {
    // a hundred steps with no prompt among them make the first fetch useless, so a second one is read
    const messages = [...Array.from({ length: 51 }, (_, k) => [user(`msg_p${k}`), step(`msg_r${k}`)]).flat(), ...Array.from({ length: 100 }, (_, k) => step(`msg_t${k}`))];
    const { reader } = withService(messages);
    const page = await reader.page(SID, false);
    expect(page.turns.length).toBeLessThanOrEqual(100);
    expect(page.cursor).not.toBeNull();
    expect(await wholeConversation(reader)).toEqual(parseOpencodeMessages(messages).turns);
  });
});

describe("older pages", () => {
  test("`since` bounds the page: it never reaches back past the turn the chat already holds", async () => {
    const { reader } = withService(chat(80, 3));
    const newest = await reader.page(SID, false);
    const older = await reader.page(SID, false, { before: newest.cursor! });
    const oldest = await reader.page(SID, false, { before: older.cursor! });
    const bounded = await reader.page(SID, false, { before: newest.cursor!, since: older.cursor! });
    expect(bounded.turns).toEqual(older.turns);
    expect(bounded.cursor).toBe(older.cursor);
    expect(oldest.turns.length).toBeGreaterThan(0);
    // nothing between the two: an empty page that still names where it stopped
    const none = await reader.page(SID, false, { before: newest.cursor!, since: newest.cursor! });
    expect(none.turns).toEqual([]);
    expect(none.cursor).toBe(newest.cursor);
  });

  test("a gap of more than a fetch is read on until `since`, not answered as a changed history", async () => {
    const { reader } = withService(chat(80, 3));
    const newest = await reader.page(SID, false);
    // about 180 messages back: the tab was in the background while more than a page arrived
    const gap = await reader.page(SID, false, { before: newest.cursor!, since: "msg_u10" });
    expect(gap.turns.length).toBeGreaterThan(0);
    expect(JSON.stringify(gap.turns)).toContain("msg_u10");
    expect(JSON.stringify(gap.turns)).not.toContain("msg_u9>");
  });

  test("a `since` the service does not have costs one look, not a walk", async () => {
    const { service, reader } = withService(chat(80, 3));
    const newest = await reader.page(SID, false);
    const calls = service.calls.length;
    await expect(reader.page(SID, false, { before: newest.cursor!, since: "msg_forged" })).rejects.toBeInstanceOf(HistoryChanged);
    expect(service.calls.slice(calls).filter((path) => path.includes("cursor="))).toEqual([]);
  });

  test("a gap longer than a walk may read is a changed history", async () => {
    const messages = [user("msg_a"), ...Array.from({ length: 1700 }, (_, k) => step(`msg_s${k}`)), user("msg_z"), step("msg_t")];
    const { service, reader } = withService(messages);
    await expect(reader.page(SID, false, { before: "msg_z", since: "msg_a" })).rejects.toBeInstanceOf(HistoryChanged);
    expect(service.listCalls).toBeLessThanOrEqual(15);
  });

  test("a `since` the walk never meets means the history changed", async () => {
    const { reader } = withService(chat(3));
    await expect(reader.page(SID, false, { before: "msg_u2", since: "msg_gone" })).rejects.toBeInstanceOf(HistoryChanged);
  });

  test("an anchor the service no longer has means the history changed, and the first message of a session is not that", async () => {
    const { service, reader } = withService(chat(3));
    await expect(reader.page(SID, false, { before: "msg_gone" })).rejects.toBeInstanceOf(HistoryChanged);
    const page = await reader.page(SID, false, { before: service.messages[0]!["id"] as string });
    expect(page.turns).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  test("an older page does not change while the session grows", async () => {
    const { service, reader } = withService(chat(80, 3));
    const newest = await reader.page(SID, false);
    const before = await reader.page(SID, false, { before: newest.cursor! });
    service.messages.push(...chat(1).map((message) => ({ ...message, id: `${message["id"] as string}_new` })));
    service.touch();
    const after = await reader.page(SID, false, { before: newest.cursor! });
    expect(after.turns).toEqual(before.turns);
    expect(after.version).toBe(before.version);
  });

  test("a cursor that is not a message id means the history changed", async () => {
    const { reader } = withService(chat(3));
    for (const page of [{ before: "../x" }, { since: "x" }, { from: "msg u" }]) await expect(reader.page(SID, false, page)).rejects.toBeInstanceOf(HistoryChanged);
  });
});

describe("polling from a held start", () => {
  test("`from` inside the newest page answers from there and keeps it as the cursor", async () => {
    const { reader } = withService(chat(80, 3));
    const newest = await reader.page(SID, false);
    const held = (await reader.page(SID, false, { from: newest.cursor! }));
    expect(held.cursor).toBe(newest.cursor);
    expect(held.turns).toEqual(newest.turns);
    const later = await reader.page(SID, false, { from: "msg_u79" });
    expect(later.cursor).toBe("msg_u79");
    expect(later.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  test("`from` the newest page has moved past still answers the newest page, from its own start", async () => {
    const { reader } = withService(chat(80, 3));
    const newest = await reader.page(SID, false);
    const moved = await reader.page(SID, false, { from: "msg_u0" });
    expect(moved.cursor).toBe(newest.cursor);
    expect(moved.turns).toEqual(newest.turns);
  });

  test("`from` the service has lost means the history changed", async () => {
    const { reader } = withService(chat(80, 3));
    await expect(reader.page(SID, false, { from: "msg_lost" })).rejects.toBeInstanceOf(HistoryChanged);
  });
});

describe("a staged revert", () => {
  const revertTo = (service: Service, id: string): void => { service.session = { ...service.session!, revert: { messageID: id } }; service.touch(); };

  test("hides its message and everything after it, down to the page where it is found", async () => {
    const { service, reader } = withService(chat(80, 3));
    revertTo(service, "msg_u70");
    const page = await reader.page(SID, false);
    const text = JSON.stringify(page.turns);
    expect(text).toContain("msg_u69");
    expect(text).not.toContain("msg_u70");
    expect(text).not.toContain("msg_a79");
    expect(await wholeConversation(reader)).toEqual(parseOpencodeMessages(service.messages.slice(0, service.messages.findIndex((m) => m["id"] === "msg_u70"))).turns);
  });

  test("a revert further back than a page still leaves the pages before it", async () => {
    const { service, reader } = withService(chat(80, 3));
    revertTo(service, "msg_u5");
    const page = await reader.page(SID, false);
    expect(JSON.stringify(page.turns)).toContain("msg_u4");
    expect(JSON.stringify(page.turns)).not.toContain("msg_u5\"");
  });

  test("older pages of what stays are read as they were", async () => {
    const { service, reader } = withService(chat(80, 3));
    const newest = await reader.page(SID, false);
    const older = await reader.page(SID, false, { before: newest.cursor! });
    revertTo(service, "msg_u70");
    // the anchor is older than the revert: untouched
    expect((await reader.page(SID, false, { before: newest.cursor! })).turns).toEqual(older.turns);
  });

  test("an anchor stamped like the revert's message is not taken for hidden, but the revert's own message is", async () => {
    const { service, reader } = withService(chat(80, 3));
    const newest = await reader.page(SID, false);
    const at = (service.messages.find((m) => m["id"] === "msg_u70")!["time"] as { created: number }).created;
    const sibling = service.messages.find((m) => m["id"] === "msg_a70_0")!;
    (sibling["time"] as { created: number }).created = at;
    revertTo(service, "msg_u70");
    await expect(reader.page(SID, false, { before: "msg_u70" })).rejects.toBeInstanceOf(HistoryChanged);
    const equal = await reader.page(SID, false, { before: "msg_a70_0" });
    expect(equal.turns.length).toBeGreaterThan(0);
    expect(newest.turns.length).toBeGreaterThan(0);
  });

  test("a revert deeper than a walk reads is no empty chat: the pane stays on its scrollback", async () => {
    const { service, reader } = withService([user("msg_first"), ...Array.from({ length: 1700 }, (_, k) => step(`msg_s${k}`))]);
    revertTo(service, "msg_first");
    await expect(reader.page(SID, false)).rejects.toBeInstanceOf(ConversationUnavailable);
  });

  test("a held start the revert hides means the history changed", async () => {
    const { service, reader } = withService(chat(80, 3));
    revertTo(service, "msg_u70");
    await expect(reader.page(SID, false, { from: "msg_u75" })).rejects.toBeInstanceOf(HistoryChanged);
    await expect(reader.page(SID, false, { before: "msg_u75" })).rejects.toBeInstanceOf(HistoryChanged);
  });
});

describe("what costs a call", () => {
  test("an unchanged session at rest costs a look at its newest message, not a read", async () => {
    const { service, reader } = withService(chat(3));
    const first = await reader.page(SID, false);
    const calls = service.listCalls;
    const second = await reader.page(SID, false);
    expect(service.listCalls).toBe(calls);
    expect(service.probes).toBe(1);
    expect(second.version).toBe(first.version);
    expect(second.turns).toEqual(first.turns);
  });

  test("a session that was written to is read again", async () => {
    const { service, reader } = withService(chat(3));
    const first = await reader.page(SID, false);
    service.messages.push(user("msg_new"));
    service.touch();
    const second = await reader.page(SID, false);
    expect(second.turns).toHaveLength(first.turns.length + 1);
    expect(second.version).not.toBe(first.version);
  });

  test("a message that leaves the session's time as it was is seen all the same: a shell command, a skill, a synthetic message", async () => {
    // OpenCode stamps the session's `time.updated` for a step, not for these
    const { service, reader } = withService(chat(3));
    const first = await reader.page(SID, false);
    const shell = { id: "msg_h", type: "shell", shellID: "sh_1", command: "<cmd>", status: "exited", exit: 0, output: { output: "<out>" }, time: { created: clock++, completed: clock } };
    service.messages.push(shell);
    const second = await reader.page(SID, false);
    expect(second.turns.at(-1)!.parts.at(-1)).toMatchObject({ kind: "tool", name: "bash", output: "<out>" });
    expect(second.version).not.toBe(first.version);
    service.messages.push({ id: "msg_k", type: "skill", skill: "id", name: "<name>", text: "<t>", time: { created: clock++ } }, { id: "msg_s", type: "synthetic", text: "<note>", time: { created: clock++ } });
    expect((await reader.page(SID, false)).turns.at(-1)!.parts[0]).toEqual({ kind: "notice", text: "<note>" });
  });

  test("a compaction that ends in place, with no new message, is seen to end", async () => {
    const running = { id: "msg_c", type: "compaction", status: "running", reason: "auto", time: { created: clock++ } };
    const { service, reader } = withService([...chat(2), running]);
    const first = await reader.page(SID, false);
    expect(first.turns.some((turn) => turn.parts.some((part) => part.kind === "compact"))).toBe(false);
    service.messages[service.messages.length - 1] = { ...running, status: "completed", summary: "<summary>" };
    const second = await reader.page(SID, false);
    expect(second.turns.at(-1)!.parts).toEqual([{ kind: "compact", text: "<summary>" }]);
  });

  test("a long turn that is still going is joined to what is held, not walked again from its start", async () => {
    const messages = [user("msg_first"), ...Array.from({ length: 250 }, (_, k) => step(`msg_s${k}`))];
    const { service, reader } = withService(messages);
    await reader.page(SID, true);
    const calls = service.listCalls;
    service.messages.push(step("msg_more"));
    const next = await reader.page(SID, true);
    expect(service.listCalls).toBe(calls + 1);
    expect(next.turns[1]!.parts).toHaveLength(251);
    // a step that changed in place inside the newest hundred is the new one
    service.messages[service.messages.length - 1] = step("msg_more", { content: [{ type: "text", text: "<changed>" }] });
    expect(JSON.stringify((await reader.page(SID, true)).turns)).toContain("<changed>");
  });

  test("what is held stays bounded however long the turn goes", async () => {
    const { service, reader } = withService([user("msg_first")]);
    for (let round = 0; round < 8; round += 1) {
      service.messages.push(...Array.from({ length: 90 }, (_, k) => step(`msg_r${round}_${k}`)));
      await reader.page(SID, true);
    }
    const held = (reader as unknown as { newest: Map<string, { messages: unknown[] }> }).newest.get(SID)!.messages;
    expect(held.length).toBeLessThanOrEqual(400);
    expect((await reader.page(SID, true)).turns.at(-1)!.parts.length).toBeGreaterThan(0);
  });

  test("a pasted image's bytes are not kept between polls", async () => {
    const png = Buffer.from("<png bytes>").toString("base64");
    const { reader } = withService([{ ...user("msg_u"), files: [{ data: png, mime: "image/png", source: { type: "inline" } }] }, step("msg_a")]);
    await reader.page(SID, false);
    const held = (reader as unknown as { newest: Map<string, { messages: { files?: { data: string; mime: string }[] }[] }> }).newest.get(SID)!.messages;
    expect(held[0]!.files![0]).toMatchObject({ data: "", mime: "image/png" });
  });

  test("a pane that is working is read at every poll: the service does not say what another server runs", async () => {
    const { service, reader } = withService(chat(3));
    await reader.page(SID, true);
    const calls = service.listCalls;
    await reader.page(SID, true);
    expect(service.listCalls).toBe(calls + 1);
  });

  test("a step still being written is read again, and once it ends the page settles", async () => {
    const writing = step("msg_w", { content: [{ type: "tool", id: "c", name: "bash", time: { created: 1 }, state: { status: "running", input: { command: "<c>" }, metadata: {} } }] });
    const { service, reader } = withService([user("msg_u"), writing]);
    await reader.page(SID, false);
    const calls = service.listCalls;
    await reader.page(SID, false);
    expect(service.listCalls).toBe(calls + 1);
    service.messages[1] = step("msg_w");
    await reader.page(SID, false);
    const settled = service.listCalls;
    await reader.page(SID, false);
    expect(service.listCalls).toBe(settled);
  });

  test("two panels asking for one page share one read", async () => {
    const { service, reader } = withService(chat(3));
    const [a, b] = await Promise.all([reader.page(SID, true), reader.page(SID, true)]);
    expect(a).toBe(b);
    expect(service.listCalls).toBe(1);
    expect(service.calls.filter((path) => path === `/api/session/${SID}`)).toHaveLength(1);
  });
});

describe("when there is nothing to read", () => {
  test("a service that is not running leaves the pane on its scrollback and starts nothing", async () => {
    const { service, reader } = withService(chat(3));
    service.running = false;
    await expect(reader.page(SID, false)).rejects.toBeInstanceOf(ConversationUnavailable);
    await expect(reader.toolOutput(SID, "msg_u0:0")).rejects.toBeInstanceOf(ConversationUnavailable);
    await expect(reader.image(SID, "msg_u0:0")).rejects.toBeInstanceOf(ConversationUnavailable);
    expect(service.calls).toEqual([]);
  });

  test("a session the service does not have is the scrollback, or a changed history when a cursor was held", async () => {
    const { service, reader } = withService(chat(3));
    service.session = null;
    await expect(reader.page(SID, false)).rejects.toBeInstanceOf(ConversationUnavailable);
    await expect(reader.page(SID, false, { from: "msg_u1" })).rejects.toBeInstanceOf(HistoryChanged);
  });

  test("a cursor the service refuses means the history changed; any other failure stays one", async () => {
    const { service, reader } = withService(chat(80, 3));
    const newest = await reader.page(SID, false);
    const original = service.get.bind(service);
    service.get = async (path) => { if (path.includes("cursor=")) throw new OpencodeHttpError(400, "InvalidCursorError"); return original(path); };
    await expect(reader.page(SID, false, { before: newest.cursor! })).rejects.toBeInstanceOf(HistoryChanged);
    service.get = async () => { throw new Error("opencode api returned no JSON"); };
    await expect(reader.page(SID, true)).rejects.toThrow("no JSON");
  });
});

describe("context window", () => {
  test("is the service's limit for the model the newest step used, asked once", async () => {
    const { service, reader } = withService(chat(3));
    service.models = [{ id: "model-x", modelID: "model-x", providerID: "prov-x", limit: { context: 200_000, output: 8000 } }, { id: "other", providerID: "prov-x", limit: { context: 1 } }];
    expect((await reader.page(SID, false)).metadata!.context).toEqual({ used: 100, window: 200_000 });
    await reader.page(SID, true);
    expect(service.calls.filter((path) => path === "/api/model")).toHaveLength(1);
  });

  test("is null when the model list cannot be read", async () => {
    const { service, reader } = withService(chat(3));
    const original = service.get.bind(service);
    service.get = async (path) => { if (path === "/api/model") throw new Error("down"); return original(path); };
    expect((await reader.page(SID, false)).metadata!.context).toEqual({ used: 100, window: null });
  });
});

describe("on demand", () => {
  const png = Buffer.from("<png bytes>").toString("base64");
  const messages = (): Row[] => [
    { ...user("msg_u"), files: [{ data: png, mime: "image/png", source: { type: "inline" } }, { data: png, mime: "application/pdf", source: { type: "inline" } }] },
    step("msg_a", { content: [{ type: "text", text: "<a>" }, { type: "tool", id: "c", name: "bash", time: { created: 1 }, state: { status: "completed", input: {}, content: [{ type: "text", text: "<whole output>" }] } }] }),
  ];

  test("a tool's whole output, by message and position", async () => {
    const { reader } = withService(messages());
    expect(await reader.toolOutput(SID, "msg_a:1")).toBe("<whole output>");
    expect(await reader.toolOutput(SID, "msg_a:0")).toBeNull();
    expect(await reader.toolOutput(SID, "msg_gone:0")).toBeNull();
    expect(await reader.toolOutput(SID, "../msg_a:1")).toBeNull();
  });

  test("a user's image, decoded, and nothing for a file that is not one", async () => {
    const { reader } = withService(messages());
    const image = await reader.image(SID, "msg_u:0");
    expect(image!.mediaType).toBe("image/png");
    expect(Buffer.from(image!.bytes).toString()).toBe("<png bytes>");
    expect(await reader.image(SID, "msg_u:1")).toBeNull();
    expect(await reader.image(SID, "msg_u:7")).toBeNull();
    expect(await reader.image(SID, "msg_a:0")).toBeNull();
    expect(await reader.image(SID, "msg_gone:0")).toBeNull();
  });
});

/** The real CLI path, with a stand-in `opencode2` that records what it was asked and answers from files. */
describe("the CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-cli-"));
  const log = join(root, "log");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const fake = join(bin, "opencode2");

  beforeAll(() => {
    writeFileSync(state, "running");
    writeFileSync(join(root, "attempts"), "0");
    writeFileSync(join(root, "big.json"), JSON.stringify({ data: [{ id: "msg_big", type: "user", text: "x".repeat(400_000) }] }));
    writeFileSync(join(root, "ok.json"), JSON.stringify({ data: { id: SID } }));
    writeFileSync(join(root, "cut.json"), '{"data":{"id":"ses_te');
    // stands in for opencode2: `service status` answers from the state file, `api GET <path>` from a file named by the path
    const script = `#!/bin/sh
echo "$@ | cwd=$(pwd) | env=$(env | grep -c '^HERDR\\|API_KEY\\|OPENCODE_')" >> ${JSON.stringify(log)}
if [ "$1" = service ] && [ "$2" = status ]; then
  if [ "$(cat ${JSON.stringify(state)})" = running ]; then echo http://127.0.0.1:1; else echo stopped; fi
  exit 0
fi
if [ "$1" = api ]; then
  case "$3" in
    */big) cat ${JSON.stringify(join(root, "big.json"))};;
    */cut) n=$(cat ${JSON.stringify(join(root, "attempts"))}); echo $((n+1)) > ${JSON.stringify(join(root, "attempts"))}
           if [ "$n" -lt 1 ]; then cat ${JSON.stringify(join(root, "cut.json"))}; else cat ${JSON.stringify(join(root, "ok.json"))}; fi;;
    */hang) trap '' TERM; sleep 5; cat ${JSON.stringify(join(root, "ok.json"))};;
    */fail) echo "boom: \\"quoted\\" detail" >&2; exit 3;;
    */huge) head -c 5000 /dev/zero | tr '\\0' a;;
    */slow) echo start >> ${JSON.stringify(join(root, "overlap"))}; sleep 0.3; echo end >> ${JSON.stringify(join(root, "overlap"))}; cat ${JSON.stringify(join(root, "ok.json"))};;
    */alwayscut) cat ${JSON.stringify(join(root, "cut.json"))};;
    */missing) echo '{"_tag":"SessionNotFoundError","message":"x"}'; echo "HTTP 404 Not Found" >&2; exit 1;;
    *) cat ${JSON.stringify(join(root, "ok.json"))};;
  esac
  exit 0
fi
exit 2
`;
    mkdirSync(bin);
    writeFileSync(fake, script);
    chmodSync(fake, 0o755);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const cli = (extra: Record<string, string> = {}, options: Partial<CliOptions> = {}) => opencodeCli({ workDir: join(root, "work"), command: fake, env: { PATH: process.env["PATH"], HOME: root, HERDR_PANE_ID: "p", OPENAI_API_KEY: "sk", OPENCODE_PASSWORD: "pw", ...extra }, ...options });
  const calls = (): string[] => readFileSync(log, "utf8").trim().split("\n");

  test("a reply of hundreds of kilobytes arrives whole at the reading end (the writer's own cut is not reproducible here)", async () => {
    const body = await cli().get("/api/session/big") as { data: { text: string }[] };
    expect(body.data[0]!.text).toHaveLength(400_000);
  });

  test("a reply cut short (a file standing in for the cut) is read again; one that stays cut is a failed read, not a crash", async () => {
    expect(await cli().get("/api/session/cut")).toEqual({ data: { id: SID } });
    await expect(cli().get("/api/session/alwayscut")).rejects.toThrow("no JSON");
  });

  test("a CLI that ignores SIGTERM is killed, and the read ends with a timeout that is not tried again", async () => {
    const before = calls().filter((line) => line.includes("/api/session/hang")).length;
    const started = Date.now();
    await expect(cli({}, { timeoutMs: 300, killGraceMs: 200 }).get("/api/session/hang")).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(calls().filter((line) => line.includes("/api/session/hang")).length - before).toBe(1);
  });

  test("an error exit with nothing to read is not tried again, and keeps what the CLI said", async () => {
    const before = calls().filter((line) => line.includes("/api/session/fail")).length;
    const error = (await cli().get("/api/session/fail").catch((reason: unknown) => reason)) as Error;
    expect(error.message).toContain("exit 3");
    expect(error.message).toContain('boom: "quoted" detail');
    expect(calls().filter((line) => line.includes("/api/session/fail")).length - before).toBe(1);
  });

  test("a reply past the limit is dropped, not held", async () => {
    await expect(cli({}, { maxReplyBytes: 1000 }).get("/api/session/huge")).rejects.toThrow("more than 1000 bytes");
  });

  test("no more CLIs run at once than allowed, however many ask", async () => {
    rmSync(join(root, "overlap"), { force: true });
    const api = cli({}, { maxChildren: 2 });
    await Promise.all(Array.from({ length: 6 }, () => api.get("/api/session/slow")));
    let open = 0;
    let most = 0;
    for (const line of readFileSync(join(root, "overlap"), "utf8").trim().split("\n")) { open += line === "start" ? 1 : -1; most = Math.max(most, open); }
    expect(most).toBe(2);
  });

  test("panels asking whether the service runs share one question", async () => {
    const before = calls().filter((line) => line.startsWith("service status")).length;
    const api = cli();
    await Promise.all([api.serviceRunning(), api.serviceRunning(), api.serviceRunning()]);
    expect(calls().filter((line) => line.startsWith("service status")).length - before).toBe(1);
  });

  test("an HTTP error carries its status and tag", async () => {
    const error = await cli().get("/api/session/missing").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect(error).toMatchObject({ status: 404, tag: "SessionNotFoundError" });
  });

  test("it runs in a folder of its own, with only the environment it needs", async () => {
    await cli().get("/api/session/ok");
    const last = calls().at(-1)!;
    expect(last).toContain(`cwd=${join(root, "work")}`);
    expect(last).toEndWith("env=0");
  });

  test("whether the service runs is asked, not assumed, and a stopped one is never asked anything else", async () => {
    const api = cli();
    expect(await api.serviceRunning()).toBe(true);
    writeFileSync(state, "stopped");
    const fresh = cli();
    expect(await fresh.serviceRunning()).toBe(false);
    const reader = new OpencodeConversations(fresh);
    const before = calls().length;
    await expect(reader.page(SID, false)).rejects.toBeInstanceOf(ConversationUnavailable);
    expect(calls().slice(before).every((line) => line.startsWith("service status"))).toBe(true);
    writeFileSync(state, "running");
  });
});
