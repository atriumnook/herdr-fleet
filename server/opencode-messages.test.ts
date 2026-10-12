import { describe, expect, test } from "bun:test";
import type { ConversationPart } from "../shared/protocol.ts";
import { questionContext } from "./explain.ts";
import { opencodeMetadata, parseOpencodeMessages, stillWriting, toolOutputOf } from "./opencode-messages.ts";
import { TOOL_OUTPUT_CHARS } from "./tool-output.ts";

/**
 * OpenCode 2's message list, as structure only: every text is a placeholder, so no fixture holds a
 * real conversation. The shapes are those the service answered with (research in the PR).
 */
let at = 1_000;
const next = (): number => (at += 1000);
const ZERO = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const model = { id: "model-x", providerID: "prov-x", variant: "default" };

const user = (id: string, text = "<user text>", files?: unknown[]) => ({ id, type: "user", time: { created: next() }, text, ...(files ? { files } : {}) });
const synthetic = (id: string, text = "<synthetic>") => ({ id, type: "synthetic", time: { created: next() }, text });
const system = (id: string, text = "<system>") => ({ id, type: "system", time: { created: next() }, text });
const tool = (id: string, state: unknown, name = "bash") => ({ type: "tool", id, name, time: { created: at }, state });
const done = (input: unknown, text: string, metadata: unknown = {}) => ({ status: "completed", input, content: [{ type: "text", text }], metadata });
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => {
  const created = next();
  return { id, type: "assistant", agent: "build", model, time: { created, completed: created + 500 }, finish: "tool-calls", cost: 0, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 0 } }, content, ...extra };
};
/** a moment after every time these messages carry */
const NOW = 100_000;
const text = (value: string) => ({ type: "text", text: value });

const tools = (parts: ConversationPart[]) => parts.filter((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool");

describe("turns", () => {
  test("a prompt and the steps that follow it are one user turn and one assistant turn", () => {
    const { turns, firstIds } = parseOpencodeMessages([
      user("msg_u1"),
      assistant("msg_a1", [{ type: "reasoning", text: "<thinking>" }, text("<commentary>"), tool("call_1", done({ command: "<cmd>\nsecond" }, "<out>", { exit: 0 }))]),
      assistant("msg_a2", [text("<answer>")], { finish: "stop" }),
    ]);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(firstIds).toEqual(["msg_u1", "msg_a1"]);
    expect(turns[0]!.parts).toEqual([{ kind: "text", text: "<user text>" }]);
    const parts = turns[1]!.parts;
    expect(parts.map((part) => part.kind)).toEqual(["thinking", "text", "tool", "text"]);
    expect(tools(parts)[0]).toMatchObject({ name: "bash", summary: "<cmd>", output: "<out>" });
    expect(tools(parts)[0]!.error).toBeUndefined();
    expect(JSON.parse(tools(parts)[0]!.input)).toEqual({ command: "<cmd>\nsecond" });
    // only the step that stopped has an answer; a step that went on to call tools is commentary
    expect(parts[1]).toEqual({ kind: "text", text: "<commentary>" });
    expect(parts[3]).toEqual({ kind: "text", text: "<answer>", phase: "final_answer" });
    expect(Date.parse(turns[0]!.ts!)).toBeGreaterThan(0);
  });

  test("an assistant turn ends where its last step did, not where the next prompt began", () => {
    const first = assistant("msg_a1", [text("<a>")]);
    const second = assistant("msg_a2", [text("<b>")]);
    const { turns } = parseOpencodeMessages([user("msg_u1"), first, second, user("msg_u2")]);
    expect(turns[1]!.ts).toBe(new Date(first.time.created).toISOString());
    expect(turns[1]!.end_ts).toBe(new Date(second.time.completed).toISOString());
  });

  test("steps with no prompt before them are an assistant turn of their own", () => {
    const { turns, firstIds } = parseOpencodeMessages([assistant("msg_a1", [text("<a>")]), user("msg_u1"), assistant("msg_a2", [text("<b>")])]);
    expect(turns.map((turn) => turn.role)).toEqual(["assistant", "user", "assistant"]);
    expect(firstIds).toEqual(["msg_a1", "msg_u1", "msg_a2"]);
  });

  test("ids are never compared: the list's order is the order", () => {
    const { turns } = parseOpencodeMessages([user("msg_zzz"), assistant("msg_aaa", [text("<a>")]), user("msg_mmm"), assistant("msg_bbb", [text("<b>")])]);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("an empty list is no turns", () => {
    expect(parseOpencodeMessages([])).toEqual({ turns: [], firstIds: [] });
  });

  test("a message of a kind a later version adds, and the switches and the idle marker, make no turn", () => {
    const { turns } = parseOpencodeMessages([
      { id: "msg_1", type: "agent-switched", time: { created: 1 }, agent: "plan" },
      { id: "msg_2", type: "model-switched", time: { created: 2 } },
      { id: "msg_3", type: "location-switched", time: { created: 3 } },
      { id: "msg_4", type: "idle", time: { created: 4 }, outcome: "succeeded" },
      { id: "msg_5", type: "from-the-future", time: { created: 5 } },
      user("msg_u"),
    ]);
    expect(turns).toHaveLength(1);
  });
});

describe("what the runtime says", () => {
  test("a synthetic message is a notice that opens its own turn, and the work after it a new assistant turn", () => {
    const { turns, firstIds } = parseOpencodeMessages([user("msg_u"), assistant("msg_a1", [text("<a>")]), synthetic("msg_s"), assistant("msg_a2", [text("<b>")])]);
    expect(turns.map((turn) => [turn.role, turn.parts[0]!.kind])).toEqual([["user", "text"], ["assistant", "text"], ["user", "notice"], ["assistant", "text"]]);
    expect(firstIds).toEqual(["msg_u", "msg_a1", "msg_s", "msg_a2"]);
  });

  test("a system message is a notice, and a notice never sits inside an assistant turn", () => {
    const { turns } = parseOpencodeMessages([user("msg_u"), assistant("msg_a1", [], { error: { type: "provider.error", message: "<why>" } }), system("msg_s", "<notice>")]);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[2]!.parts).toEqual([{ kind: "notice", text: "<notice>" }]);
    expect(turns.filter((turn) => turn.role === "assistant").every((turn) => turn.parts.every((part) => part.kind !== "notice"))).toBe(true);
  });

  test("a notice shows its description, the summary meant for a transcript, before the text the model was told", () => {
    const { turns } = parseOpencodeMessages([
      { id: "msg_s", type: "synthetic", time: { created: 1 }, text: "<what the model was told>", description: "<described>" },
      { id: "msg_i", type: "system", time: { created: 2 }, text: "<instructions delta>", description: "<Instructions updated: source>" },
      { id: "msg_t", type: "system", time: { created: 3 }, text: "<only text>" },
    ]);
    expect(turns.map((turn) => turn.parts[0])).toEqual([
      { kind: "notice", text: "<described>" },
      { kind: "notice", text: "<Instructions updated: source>" },
      { kind: "notice", text: "<only text>" },
    ]);
  });

  test("a notice with neither shows nothing, and a long one is cut", () => {
    const { turns } = parseOpencodeMessages([{ id: "msg_e", type: "system", time: { created: 2 }, text: "  " }, { id: "msg_l", type: "system", time: { created: 3 }, text: "x".repeat(10_000) }]);
    expect(turns).toHaveLength(1);
    expect((turns[0]!.parts[0] as { text: string }).text).toHaveLength(4000);
  });

  test("a completed compaction is the summary it left; a running one shows nothing; a failed one says so", () => {
    const completed = { id: "msg_c1", type: "compaction", status: "completed", reason: "auto", time: { created: 1 }, summary: "<summary>", recent: "<recent>" };
    const running = { id: "msg_c2", type: "compaction", status: "running", reason: "manual", time: { created: 2 } };
    const failed = { id: "msg_c3", type: "compaction", status: "failed", reason: "auto", time: { created: 3 }, error: { message: "<why>" } };
    expect(parseOpencodeMessages([completed]).turns).toEqual([{ role: "user", ts: new Date(1).toISOString(), parts: [{ kind: "compact", text: "<summary>" }] }]);
    expect(parseOpencodeMessages([running]).turns).toEqual([]);
    expect(parseOpencodeMessages([failed]).turns[0]!.parts).toEqual([{ kind: "text", text: "Error: compaction failed: <why>" }]);
  });

  test("a loaded skill is skill activity under its name, not its id", () => {
    const { turns } = parseOpencodeMessages([{ id: "msg_k", type: "skill", skill: "<skill id>", name: "<skill name>", text: "<instructions>", time: { created: 1 } }]);
    expect(turns[0]!.parts).toEqual([{ kind: "skill", skill: { name: "<skill name>", evidence: "instructions", status: "loaded" } }]);
    expect(parseOpencodeMessages([{ id: "msg_k", type: "skill", skill: "<skill id>", text: "<i>", time: { created: 1 } }]).turns[0]!.parts[0]).toMatchObject({ skill: { name: "<skill id>" } });
  });
});

describe("a user's message", () => {
  test("an image is addressed by message and position; another file is a line naming it; the bytes stay out", () => {
    const { turns } = parseOpencodeMessages([user("msg_u", "<user text>", [
      { data: "<base64>", mime: "image/png", source: { type: "inline" }, name: "<image>" },
      { data: "<base64>", mime: "application/pdf", source: { type: "inline" }, name: "<doc>" },
      { data: "<base64>", mime: "image/svg+xml", source: { type: "inline" } },
    ])]);
    expect(turns[0]!.parts).toEqual([
      { kind: "text", text: "<user text>" },
      { kind: "image", media_type: "image/png", ref: "msg_u:0" },
      { kind: "text", text: "[file: <doc>]" },
      { kind: "text", text: "[file: image/svg+xml]" },
    ]);
    expect(JSON.stringify(turns)).not.toContain("<base64>");
  });

  test("a prompt of only an image is a turn", () => {
    const { turns } = parseOpencodeMessages([user("msg_u", "", [{ data: "<base64>", mime: "image/jpeg", source: { type: "inline" } }])]);
    expect(turns[0]!.parts).toEqual([{ kind: "image", media_type: "image/jpeg", ref: "msg_u:0" }]);
  });

  test("a prompt of nothing is no turn, and the turn after it still has its message as the cursor", () => {
    const { turns, firstIds } = parseOpencodeMessages([user("msg_u1", ""), user("msg_u2")]);
    expect(turns).toHaveLength(1);
    expect(firstIds).toEqual(["msg_u2"]);
  });
});

describe("tools", () => {
  test("a failed tool shows its error, or the content it left", () => {
    const { turns } = parseOpencodeMessages([assistant("msg_a", [
      tool("c1", { status: "error", input: { filePath: "<p>", oldString: "<a>", newString: "<b>" }, error: { type: "tool.execution", message: "<msg>" } }, "edit"),
      tool("c2", { status: "error", input: { filePath: "<p>" }, error: { type: "tool.execution", message: "<msg>" }, content: [{ type: "text", text: "<partial>" }] }, "write"),
    ])]);
    const [edit, write] = tools(turns[0]!.parts);
    expect(edit).toMatchObject({ name: "edit", summary: "<p>", output: "<msg>", error: true });
    expect(write).toMatchObject({ output: "<partial>", error: true });
  });

  test("a command that exited non-zero failed, whatever its status says", () => {
    const { turns } = parseOpencodeMessages([assistant("msg_a", [tool("c1", done({ command: "<c>" }, "<out>", { exit: 2 })), tool("c2", done({ command: "<c>" }, "<out>", { exit: 0 })), tool("c3", done({ filePath: "<p>" }, "<out>", {}), "read")])]);
    expect(tools(turns[0]!.parts).map((part) => part.error)).toEqual([true, undefined, undefined]);
  });

  test("a tool still streaming or running is shown with no output, its input as it stands", () => {
    const { turns } = parseOpencodeMessages([assistant("msg_a", [
      tool("c1", { status: "streaming", input: '{"command":"<par' }),
      tool("c2", { status: "running", input: { command: "<cmd>" }, metadata: {} }),
    ], { time: { created: 1 } })]);
    const [streaming, running] = tools(turns[0]!.parts);
    expect(streaming).toMatchObject({ input: '{"command":"<par', output: "", summary: "bash" });
    expect(running).toMatchObject({ output: "", summary: "<cmd>" });
    expect(turns[0]!.end_ts).toBe(new Date(1).toISOString());
  });

  test("a file a tool returned is a line, and the uri is not shown", () => {
    const { turns } = parseOpencodeMessages([assistant("msg_a", [tool("c1", { status: "completed", input: {}, content: [{ type: "text", text: "<t>" }, { type: "file", uri: "file:///private/path.png", mime: "image/png", name: "<shot>" }] })])]);
    expect(tools(turns[0]!.parts)[0]!.output).toBe("<t>\n[file: <shot>]");
    expect(JSON.stringify(turns)).not.toContain("/private/path");
  });

  test("an output past the page's limit is cut and fetched by message and position", () => {
    const whole = "x".repeat(TOOL_OUTPUT_CHARS + 1);
    const { turns } = parseOpencodeMessages([assistant("msg_a", [text("<a>"), tool("c1", done({ command: "<c>" }, whole))])]);
    const part = tools(turns[0]!.parts)[0]!;
    expect(part.output_ref).toBe("msg_a:1");
    expect(part.output_size).toBe(whole.length);
    expect(part.output.endsWith("… trimmed")).toBe(true);
    expect(toolOutputOf(assistant("msg_a", [text("<a>"), tool("c1", done({ command: "<c>" }, whole))]), 1)).toBe(whole);
  });

  test("the whole output of anything that is not a tool call is null", () => {
    const message = assistant("msg_a", [text("<a>"), tool("c1", done({}, "<out>"))]);
    expect(toolOutputOf(message, 0)).toBeNull();
    expect(toolOutputOf(message, 5)).toBeNull();
    expect(toolOutputOf(user("msg_u"), 0)).toBeNull();
    expect(toolOutputOf(undefined, 0)).toBeNull();
  });

  test("a user's shell command is a bash call in the assistant's turn", () => {
    const ran = { id: "msg_h1", type: "shell", shellID: "sh_1", command: "<cmd>", status: "exited", exit: 0, output: { output: "<out>", cursor: 1, size: 5, truncated: false }, time: { created: 1, completed: 2 } };
    const failed = { ...ran, id: "msg_h2", exit: 1 };
    const killed = { ...ran, id: "msg_h3", status: "killed", exit: undefined };
    const { turns } = parseOpencodeMessages([ran, failed, killed]);
    expect(turns).toHaveLength(1);
    const [first, second, third] = tools(turns[0]!.parts);
    expect(first).toMatchObject({ name: "bash", input: "<cmd>", output: "<out>" });
    expect(first!.error).toBeUndefined();
    expect(second!.error).toBe(true);
    expect(third!.error).toBe(true);
    expect(toolOutputOf({ ...ran, output: { output: "x".repeat(5) } }, 0)).toBe("xxxxx");
  });
});

describe("a step that did not finish", () => {
  test("an aborted step is Interrupted; a provider error says why; both leave the empty content out", () => {
    const aborted = assistant("msg_a1", [], { tokens: ZERO, error: { type: "aborted", message: "<msg>" } });
    const failed = assistant("msg_a2", [], { tokens: ZERO, error: { type: "provider.error", message: "<why>" } });
    const { turns } = parseOpencodeMessages([user("msg_u"), aborted, failed]);
    expect(turns[1]!.parts).toEqual([{ kind: "text", text: "Interrupted" }, { kind: "text", text: "Error: <why>" }]);
  });

  test("a step with no finish and no end is still being written", () => {
    const active = { ...assistant("msg_a", [text("<partial>")]), time: { created: 1 } };
    delete (active as Record<string, unknown>)["finish"];
    expect(parseOpencodeMessages([user("msg_u"), active]).turns[1]!.parts).toEqual([{ kind: "text", text: "<partial>" }]);
    expect(stillWriting([user("msg_u"), active], NOW)).toBe(true);
  });
});

describe("whether the end of the list is still being written", () => {
  test("an ended step is not", () => {
    expect(stillWriting([user("msg_u"), assistant("msg_a", [text("<a>")])], NOW)).toBe(false);
    expect(stillWriting([], NOW)).toBe(false);
  });

  test("a step that ended with a tool still running is", () => {
    expect(stillWriting([assistant("msg_a", [tool("c", { status: "running", input: {}, metadata: {} })])], NOW)).toBe(true);
    expect(stillWriting([assistant("msg_a", [tool("c", { status: "streaming", input: "" })])], NOW)).toBe(true);
  });

  test("an errored step with no end is not: it was cut off", () => {
    const cut = { ...assistant("msg_a", []), time: { created: 1 }, error: { type: "aborted", message: "<m>" } };
    expect(stillWriting([cut], NOW)).toBe(false);
  });

  test("a shell command is while it runs, and so is a compaction: both change in place", () => {
    expect(stillWriting([{ id: "msg_h", type: "shell", status: "running", command: "<c>", time: { created: 1 } }], NOW)).toBe(true);
    expect(stillWriting([{ id: "msg_c", type: "compaction", status: "running", reason: "auto", time: { created: 1 } }], NOW)).toBe(true);
    expect(stillWriting([{ id: "msg_c", type: "compaction", status: "completed", reason: "auto", time: { created: 1 }, summary: "<s>" }], NOW)).toBe(false);
  });

  test("a step left unfinished for ten minutes was cut off, not written still", () => {
    const active = { ...assistant("msg_a", [text("<partial>")]), time: { created: 1 } };
    delete (active as Record<string, unknown>)["finish"];
    expect(stillWriting([active], 1 + 9 * 60_000)).toBe(true);
    expect(stillWriting([active], 1 + 11 * 60_000)).toBe(false);
    expect(stillWriting([{ id: "msg_h", type: "shell", status: "running", command: "<c>", time: { created: 1 } }], 1 + 11 * 60_000)).toBe(false);
  });

  test("the newest step decides, not an older one", () => {
    const old = { ...assistant("msg_a1", []), time: { created: 1 } };
    expect(stillWriting([old, assistant("msg_a2", [text("<a>")])], NOW)).toBe(false);
  });
});

describe("metadata", () => {
  const windows = (provider: string, id: string): number | null => (provider === "prov-x" && id === "model-x" ? 200_000 : null);

  test("the model of the newest step, its variant unless it is the default, and what the newest request filled", () => {
    const steps = [
      assistant("msg_a1", [text("<a>")], { model: { id: "old", providerID: "prov-x" }, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 1, write: 1 } } }),
      assistant("msg_a2", [text("<b>")], { model: { id: "model-x", providerID: "prov-x", variant: "high" }, tokens: { input: 10, output: 999, reasoning: 5, cache: { read: 100, write: 20 } } }),
    ];
    expect(opencodeMetadata(steps, windows)).toEqual({ model: "prov-x/model-x", reasoning_effort: "high", context: { used: 130, window: 200_000 } });
    expect(opencodeMetadata([assistant("msg_a", [], { model })], windows).reasoning_effort).toBeNull();
  });

  test("a step that reported no tokens says nothing of the context, so the one before it does", () => {
    const steps = [assistant("msg_a1", [text("<a>")]), assistant("msg_a2", [], { tokens: ZERO, error: { type: "aborted", message: "<m>" } })];
    expect(opencodeMetadata(steps, windows).context).toEqual({ used: 110, window: 200_000 });
  });

  test("a window the service does not state is null, and a session with no step has no model", () => {
    expect(opencodeMetadata([assistant("msg_a", [text("<a>")], { model: { id: "unknown", providerID: "prov-y" } })]).context).toEqual({ used: 110, window: null });
    expect(opencodeMetadata([user("msg_u")])).toEqual({ model: null, reasoning_effort: null });
  });
});

describe("explaining a question in an OpenCode pane", () => {
  test("the person's prompts, the narration before the question and the calls since it are what the explanation reads", () => {
    const { turns } = parseOpencodeMessages([
      user("msg_u", "<what I asked>"),
      assistant("msg_a1", [text("<narration>"), tool("c1", done({ command: "<cmd>" }, "<out>"))]),
      assistant("msg_a2", [tool("c2", { status: "running", input: { filePath: "<file>" }, metadata: {} }, "edit")], { time: { created: 1 } }),
    ]);
    expect(questionContext(turns)).toEqual({ prompts: ["<what I asked>"], lead: "<narration>", tools: ["bash: <cmd>", "edit: <file>"] });
  });
});
