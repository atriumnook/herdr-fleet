import { describe, expect, it } from "bun:test";
import type { HerdrPane } from "../shared/protocol.ts";
import type { SideChatSnapshot } from "../shared/side-chat.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { handleSideChatRequest } from "./side-chat-api.ts";
import { MAX_SIDE_CHATS, SideChats, sessionPlace, sideChatArgv, sideChatPlan, type SideChatPlan, type SideChatPlanIo, type SideChatProcess } from "./side-chat.ts";

/** A claude process the test speaks for: what it was sent, and the events it prints. */
class FakeClaude implements SideChatProcess {
  readonly sent: Record<string, any>[] = [];
  killed = false;
  private readonly queue: string[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private exit!: (code: number) => void;
  readonly exited = new Promise<number>((resolve) => { this.exit = resolve; });
  stderr = Promise.resolve("");
  constructor(readonly argv: string[], readonly cwd: string) {}
  write(line: string): void { this.sent.push(JSON.parse(line)); }
  print(...events: Record<string, unknown>[]): void {
    this.queue.push(...events.map((event) => JSON.stringify(event)));
    this.wake?.();
  }
  quit(code: number, stderr = ""): void {
    this.stderr = Promise.resolve(stderr);
    this.done = true;
    this.wake?.();
    this.exit(code);
  }
  kill(): void { this.killed = true; this.quit(143); }
  get lines(): AsyncIterable<string> {
    const self = this;
    return (async function* () {
      while (true) {
        while (self.queue.length) yield self.queue.shift()!;
        if (self.done) return;
        await new Promise<void>((resolve) => { self.wake = resolve; });
        self.wake = null;
      }
    })();
  }
}

const FORK: SideChatPlan = { kind: "fork", cwd: "/repo", session: "11111111-2222-3333-4444-555555555555", model: "claude-opus-5-5" };

function setup(plan: (paneId: string) => Promise<SideChatPlan> = async () => FORK) {
  const processes: FakeClaude[] = [];
  const chats = new SideChats({ plan, spawn: (argv, cwd) => { const claude = new FakeClaude(argv, cwd); processes.push(claude); return claude; } });
  const seen: (SideChatSnapshot | null)[] = [];
  return { chats, processes, seen };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (value: string) => ({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: value }] } });

describe("side chats", () => {
  it("go on from the pane's Claude session in print mode, keep nothing, and refuse every file edit", () => {
    const argv = sideChatArgv(FORK);
    expect(argv.slice(0, 2)).toEqual(["claude", "-p"]);
    for (const flag of ["--no-session-persistence", "--fork-session", "--include-partial-messages"]) expect(argv).toContain(flag);
    expect(argv.join(" ")).toContain("--resume 11111111-2222-3333-4444-555555555555 --fork-session --model claude-opus-5-5");
    expect(argv.join(" ")).toContain("--permission-mode auto");
    // the tools and the instructions stay the session's: no --disallowedTools, no --append-system-prompt
    expect(argv.join(" ")).not.toMatch(/--disallowed|--append-system|--tools|--system-prompt/);
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Edit|MultiEdit|Write|NotebookEdit");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("exit 2");
    // a pane with no Claude session: the folder's project settings stay out
    const context = sideChatArgv({ kind: "context", cwd: "/repo", context: "x" });
    expect(context.join(" ")).toContain("--setting-sources user");
    expect(context).not.toContain("--resume");
  });

  it("ask the first question with what a side chat is, show only the question, and stream the reply", async () => {
    const { chats, processes, seen } = setup();
    chats.watch("w1:p1", (chat) => seen.push(chat));
    const chat = await chats.start("w1:p1", "Why that design?");
    const claude = processes[0]!;
    expect(claude.cwd).toBe("/repo");
    expect(chat).toMatchObject({ paneId: "w1:p1", source: "fork", status: "working", turns: [{ role: "user", parts: [{ kind: "text", text: "Why that design?" }] }] });
    const sent = claude.sent[0]!;
    expect(sent.type).toBe("user");
    expect(sent.message.content[0].text).toStartWith("[Side chat]");
    expect(sent.message.content[0].text).toEndWith("Question:\nWhy that design?");

    claude.print({ type: "stream_event", event: { type: "message_start" } }, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Because" } } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(chats.current("w1:p1")!.streaming).toBe("Because");
    claude.print(text("Because it is simpler."), { type: "result", subtype: "success", is_error: false, result: "Because it is simpler." });
    await tick();
    const now = chats.current("w1:p1")!;
    expect(now).toMatchObject({ status: "idle", streaming: "", error: null });
    expect(now.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(now.turns[1]!.parts).toEqual([{ kind: "text", text: "Because it is simpler." }]);
    expect(seen[0]).toBeNull();
    expect(seen.at(-1)).toEqual(now);

    // the next question goes as typed
    chats.send(chat.id, "And the tests?");
    expect(claude.sent[1]!.message.content[0].text).toBe("And the tests?");
    expect(chats.current("w1:p1")!.status).toBe("working");

    // one sent mid-turn: the first turn's end is not the second's
    chats.send(chat.id, "And the docs?");
    claude.print({ type: "result", subtype: "success", is_error: false });
    await tick();
    expect(chats.current("w1:p1")!.status).toBe("working");
    claude.print({ type: "result", subtype: "success", is_error: false });
    await tick();
    expect(chats.current("w1:p1")!.status).toBe("idle");
  });

  it("hand a pane without a Claude session its conversation in the first message", async () => {
    const { chats, processes } = setup(async () => ({ kind: "context", cwd: "/repo", context: "# The conversation the person asks about\n\n## Person\n\nfix it\n" }));
    await chats.start("w1:p1", "What broke?");
    const first = processes[0]!.sent[0]!.message.content[0].text as string;
    expect(first).toContain("## Person\n\nfix it");
    expect(first).toEndWith("Question:\nWhat broke?");
    expect(chats.current("w1:p1")!.turns[0]!.parts).toEqual([{ kind: "text", text: "What broke?" }]);
  });

  it("stop a turn without calling it a failure, and say why one failed", async () => {
    const { chats, processes } = setup();
    const chat = await chats.start("w1:p1", "q");
    const claude = processes[0]!;
    chats.interrupt(chat.id);
    expect(claude.sent[1]).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
    claude.print({ type: "result", subtype: "error_during_execution", is_error: true });
    await tick();
    expect(chats.current("w1:p1")).toMatchObject({ status: "idle", error: null });
    // a stop that came as the turn ended is no stop of the next one: its failure is said
    chats.send(chat.id, "again");
    chats.interrupt(chat.id);
    claude.print({ type: "result", subtype: "success", is_error: false });
    await tick();
    chats.send(chat.id, "again");
    claude.print({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    await tick();
    expect(chats.current("w1:p1")).toMatchObject({ status: "idle", error: "Not logged in · Please run /login" });
  });

  it("end when claude stops, saying what it said", async () => {
    const { chats, processes } = setup();
    const chat = await chats.start("w1:p1", "q");
    processes[0]!.quit(1, "No conversation found with session ID: 1111");
    await tick(); await tick();
    expect(chats.current("w1:p1")).toMatchObject({ status: "ended", error: "No conversation found with session ID: 1111" });
    expect(() => chats.send(chat.id, "more")).toThrow(expect.objectContaining({ code: "side_chat_ended" }));
  });

  it("keep one per pane: a new one ends the one before, and closing forgets it", async () => {
    const { chats, processes, seen } = setup();
    chats.watch("w1:p1", (chat) => seen.push(chat));
    const first = await chats.start("w1:p1", "one");
    const second = await chats.start("w1:p1", "two");
    expect(processes[0]!.killed).toBe(true);
    expect(chats.current("w1:p1")!.id).toBe(second.id);
    expect(() => chats.send(first.id, "x")).toThrow(expect.objectContaining({ code: "side_chat_not_found" }));
    chats.close(second.id);
    expect(processes[1]!.killed).toBe(true);
    expect(chats.current("w1:p1")).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it(`run at most ${MAX_SIDE_CHATS} at once: the one asked longest ago that is waiting ends for a new one`, async () => {
    const { chats, processes } = setup();
    for (let index = 0; index < MAX_SIDE_CHATS; index++) await chats.start(`w1:p${index}`, "q");
    await expect(chats.start("w1:p9", "q")).rejects.toMatchObject({ code: "side_chat_busy" });
    for (const claude of processes) claude.print({ type: "result", subtype: "success", is_error: false });
    await tick();
    await chats.start("w1:p9", "q");
    expect(processes[0]!.killed).toBe(true);
    expect(chats.current("w1:p0")).toMatchObject({ status: "ended", error: null });
    expect(processes.slice(1, MAX_SIDE_CHATS).every((claude) => !claude.killed)).toBe(true);
  });

  it("keep the pane's side chat when a new one cannot start", async () => {
    const processes: FakeClaude[] = [];
    let fail = false;
    const chats = new SideChats({ plan: async () => FORK, spawn: (argv, cwd) => {
      if (fail) throw new Error("ENOENT: claude");
      const claude = new FakeClaude(argv, cwd); processes.push(claude); return claude;
    } });
    const first = await chats.start("w1:p1", "q");
    fail = true;
    await expect(chats.start("w1:p1", "again")).rejects.toThrow("ENOENT");
    expect(chats.current("w1:p1")!.id).toBe(first.id);
    expect(processes[0]!.killed).toBe(false);
    // and when every other one is answering, the pane's own still gives way to its new one
    fail = false;
    for (let index = 2; index <= MAX_SIDE_CHATS; index++) await chats.start(`w1:p${index}`, "q");
    const replaced = await chats.start("w1:p1", "new");
    expect(replaced.id).not.toBe(first.id);
    expect(processes[0]!.killed).toBe(true);
  });

  it("stay ended when a result comes after the end", async () => {
    const { chats, processes } = setup();
    for (let index = 0; index < MAX_SIDE_CHATS; index++) await chats.start(`w1:p${index}`, "q");
    for (const claude of processes) claude.print({ type: "result", subtype: "success", is_error: false });
    await tick();
    await chats.start("w1:p9", "q");
    // a result line read after the eviction
    processes[0]!.print({ type: "result", subtype: "success", is_error: false });
    await tick();
    expect(chats.current("w1:p0")!.status).toBe("ended");
  });

  it("want a question", async () => {
    const { chats } = setup();
    await expect(chats.start("w1:p1", "  ")).rejects.toMatchObject({ code: "missing_text" });
  });
});

describe("a side chat's plan", () => {
  const pane = (fields: Partial<HerdrPane>): HerdrPane => ({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo/sub", ...fields } as HerdrPane);
  const io = (fields: Partial<SideChatPlanIo>): SideChatPlanIo => ({
    pane: async () => undefined, claudeSession: async () => null, transcriptFile: async () => null, transcriptEnds: async () => "",
    conversation: async () => [], screen: async () => "", ...fields,
  });
  const session = "11111111-2222-3333-4444-555555555555";
  const lines = [
    JSON.stringify({ type: "user", cwd: "/repo", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", cwd: "/repo", message: { model: "claude-sonnet-5-5", content: [] } }),
    JSON.stringify({ type: "assistant", cwd: "/repo/sub", message: { model: "<synthetic>", content: [] } }),
  ].join("\n");

  it("forks a Claude pane's session from the folder it started in, with the model it answered with", async () => {
    expect(sessionPlace(lines, claudeProjectDir("/repo"), [])).toEqual({ cwd: "/repo", model: "claude-sonnet-5-5" });
    const plan = await sideChatPlan("w1:p1", io({
      pane: async () => pane({ agent: "claude" }), claudeSession: async () => session,
      transcriptFile: async () => `/home/me/.claude/projects/${claudeProjectDir("/repo")}/${session}.jsonl`, transcriptEnds: async () => lines,
    }));
    expect(plan).toEqual({ kind: "fork", cwd: "/repo", session, model: "claude-sonnet-5-5" });
  });

  it("hands any other pane its conversation, else its screen, and needs a folder", async () => {
    const conversation = await sideChatPlan("w1:p1", io({ pane: async () => pane({ agent: "codex" }), conversation: async () => [{ role: "user", ts: null, parts: [{ kind: "text", text: "fix it" }] }] }));
    expect(conversation).toMatchObject({ kind: "context", cwd: "/repo/sub" });
    expect((conversation as { context: string }).context).toContain("fix it");
    // a Claude pane whose transcript is not found is read like any other
    const screen = await sideChatPlan("w1:p1", io({ pane: async () => pane({ agent: "claude" }), claudeSession: async () => session, screen: async () => "$ make\nok" }));
    expect((screen as { context: string }).context).toContain("$ make\nok");
    await expect(sideChatPlan("w1:p1", io({}))).rejects.toMatchObject({ code: "pane_not_found" });
    await expect(sideChatPlan("w1:p1", io({ pane: async () => pane({ cwd: null, foreground_cwd: null }) }))).rejects.toMatchObject({ code: "pane_without_folder" });
  });
});

describe("the side chats' HTTP API", () => {
  const call = async (chats: SideChats, method: string, path: string, body?: unknown) => {
    const url = new URL(`http://127.0.0.1:7317/api/side-chats${path}`);
    return handleSideChatRequest(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, chats);
  };

  it("starts, asks, stops a turn and closes a side chat, and streams the pane's", async () => {
    const { chats } = setup();
    const events = await call(chats, "GET", "/events?pane_id=w1:p1");
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(`data: ${JSON.stringify({ chat: null })}\n\n`);

    const started = await call(chats, "POST", "", { pane_id: "w1:p1", text: "why?" });
    expect(started.status).toBe(201);
    const { chat } = await started.json() as { chat: SideChatSnapshot };
    expect(decoder.decode((await reader.read()).value)).toContain(`"id":"${chat.id}"`);
    expect((await call(chats, "POST", `/${chat.id}/messages`, { text: "and?" })).status).toBe(200);
    expect((await call(chats, "POST", `/${chat.id}/interrupt`)).status).toBe(200);
    expect((await call(chats, "DELETE", `/${chat.id}`)).status).toBe(204);
    expect(await (await call(chats, "DELETE", `/${chat.id}`)).json()).toMatchObject({ error: { code: "side_chat_not_found" } });
    await reader.cancel();
  });

  it("refuses what is not a side chat's request", async () => {
    const { chats } = setup();
    expect((await call(chats, "GET", "/events?pane_id=w1:p1]\n")).status).toBe(400);
    expect((await call(chats, "POST", "", { pane_id: "w1:p1" })).status).toBe(400);
    expect((await call(chats, "POST", "", { pane_id: 3, text: "q" })).status).toBe(400);
    expect((await call(chats, "POST", "", { pane_id: "w1:p1", text: " " })).status).toBe(400);
    expect((await call(chats, "POST", "/not-an-id/messages", { text: "q" })).status).toBe(404);
  });
});
