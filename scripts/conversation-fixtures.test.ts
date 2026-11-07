import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCases, RecordedOpencodeApi, replyKey, runCase, update, validateCase, withCase, type ConversationCase, type LoadedCase } from "./conversation-fixtures.ts";
import { OpencodeHttpError } from "../server/opencode-cli.ts";

const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const SESSION = jsonl(
  { type: "user", timestamp: "2026-09-19T08:00:00.000Z", message: { role: "user", content: "start" } },
  { type: "assistant", timestamp: "2026-09-19T08:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
);
const MORE = jsonl({ type: "user", timestamp: "2026-09-19T08:01:00.000Z", message: { role: "user", content: "again" } });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function corpus(cases: Record<string, { files?: Record<string, string>; spec: unknown }>): string {
  const root = mkdtempSync(join(tmpdir(), "conversation-fixtures-"));
  roots.push(root);
  for (const [name, { files = {}, spec }] of Object.entries(cases)) {
    mkdirSync(join(root, name), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, name, file), text);
    writeFileSync(join(root, name, "case.json"), JSON.stringify(spec));
  }
  return root;
}
const raw = (root: string, name: string) => readFileSync(join(root, name, "case.json"), "utf8");
const read = (root: string, name: string) => JSON.parse(raw(root, name)) as ConversationCase;
const page = (extra: Record<string, unknown> = {}) => ({ call: "page", source: "claude", path: "session.jsonl", ...extra });
const loaded = (root: string, name: string): LoadedCase => loadCases(root).find((each) => each.name === name)!;

describe("conversation corpus update", () => {
  test("fills only the cases with a call without an expected value, and leaves a stale one as it is", async () => {
    const root = corpus({
      "claude/new": { files: { "session.jsonl": SESSION }, spec: { about: "a", steps: [page()] } },
      "claude/stale": { files: { "session.jsonl": SESSION }, spec: { about: "b", steps: [{ ...page(), expected: "not what the code returns" }] } },
    });
    const stale = raw(root, "claude/stale");
    expect(await update([], root)).toEqual(["claude/new"]);
    const filled = read(root, "claude/new");
    expect(filled.about).toBe("a");
    expect(filled.steps[0]).toMatchObject({ ...page(), expected: { source: "claude-transcript", cursor: null, history_id: "$h", version: "$v1" } });
    expect(raw(root, "claude/stale")).toBe(stale);
    // written, the case passes as it is
    const { values } = await runCase(loaded(root, "claude/new"));
    expect(values[0]).toStrictEqual((filled.steps[0] as { expected: unknown }).expected);
  });

  test("rewrites a case it is named, and nothing it is not named", async () => {
    const root = corpus({
      "claude/stale": { files: { "session.jsonl": SESSION }, spec: { steps: [{ ...page(), expected: "old" }] } },
      "claude/other": { files: { "session.jsonl": SESSION }, spec: { steps: [{ ...page(), expected: "other" }] } },
    });
    const other = raw(root, "claude/other");
    expect(await update(["claude/stale"], root)).toEqual(["claude/stale"]);
    expect((read(root, "claude/stale").steps[0] as { expected: unknown }).expected).toMatchObject({ history_id: "$h" });
    expect(raw(root, "claude/other")).toBe(other);
    await expect(update(["claude/none"], root)).rejects.toThrow("no such case: claude/none");
  });

  test("names each value that changes with every run once, in the order it appears, and keeps the names the steps pass", async () => {
    const root = corpus({
      "claude/names": {
        files: { "session.jsonl": SESSION, "more.jsonl": MORE },
        spec: { steps: [page(), page(), { append: "session.jsonl", from: "more.jsonl" }, page(), { rewrite: "session.jsonl", text: SESSION }, page()] },
      },
    });
    await update([], root);
    const expected = read(root, "claude/names").steps.flatMap((step) => "call" in step ? [step.expected as Record<string, unknown>] : []);
    // the same page of the same file is the same answer; an append is a new version of it; a rewrite is another history
    expect(expected.map(({ history_id, version }) => [history_id, version])).toEqual([["$h", "$v1"], ["$h", "$v1"], ["$h", "$v2"], ["$h2", "$v3"]]);
  });

  test("keeps a name a step passes to a later step, and a name the author gave", async () => {
    const lines = Array.from({ length: 130 }, (_, n) => ({ type: "user", message: { role: "user", content: `m${n}` } }));
    const root = corpus({
      "claude/held": {
        files: { "session.jsonl": jsonl(...lines) },
        spec: { steps: [{ ...page(), expected: { cursor: "$newest", history_id: "$id" } }, page({ page: { before: "$newest" } })] },
      },
    });
    await update(["claude/held"], root);
    const [first, second] = read(root, "claude/held").steps as { expected: Record<string, unknown> }[];
    expect(first!.expected).toMatchObject({ cursor: "$newest", history_id: "$id", version: "$v1" });
    expect(second!.expected).toMatchObject({ cursor: "$c1", history_id: "$id", version: "$v2" });
    // the page before the newest one is read through the name: it holds the turns the newest left out
    expect((second!.expected["turns"] as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("conversation corpus names", () => {
  const twice = (first: Record<string, unknown>, second: Record<string, unknown>) => corpus({
    "claude/case": { files: { "session.jsonl": SESSION, "more.jsonl": MORE }, spec: { steps: [{ ...page(), expected: first }, { append: "session.jsonl", from: "more.jsonl" }, { ...page(), expected: second }] } },
  });
  const values = async (root: string) => (await runCase(loaded(root, "claude/case"))).values.filter((value) => value !== undefined) as Record<string, unknown>[];

  test("binds a name where it first appears, and checks it after", async () => {
    const [first, second] = await values(twice({ history_id: "$h", version: "$v" }, { history_id: "$h", version: "$v" }));
    expect(first).toMatchObject({ history_id: "$h", version: "$v" });
    // the same history: the name fits; another version: the value stays as it is, and the comparison shows it
    expect(second!["history_id"]).toBe("$h");
    expect(second!["version"]).not.toBe("$v");
    expect(second!["version"]).not.toStartWith("$");
  });

  test("checks that a !$name is another value, and that two names never name one value", async () => {
    const [, second] = await values(twice({ history_id: "$h", version: "$v" }, { history_id: "$other", version: "!$v" }));
    expect(second!["version"]).toBe("!$v");
    expect(second!["history_id"]).not.toBe("$other");
    const [, same] = await values(twice({ version: "$v" }, { history_id: "!$h" }));
    // a !$name of a name not given fits no value
    expect(same!["history_id"]).not.toBe("!$h");
  });

  test("refuses a name passed before a step gives it", async () => {
    const root = corpus({ "claude/case": { files: { "session.jsonl": SESSION }, spec: { steps: [page({ page: { before: "$c9" } })] } } });
    await expect(runCase(loaded(root, "claude/case"))).rejects.toThrow("$c9 is passed before a step names it");
  });

  test("writes the case folder's path $CASE wherever a string holds it", () => {
    const folders = ["/private/tmp/herdr-conversation-x/case", "/tmp/herdr-conversation-x/case"];
    expect(withCase({ a: ["/tmp/herdr-conversation-x/case/session.jsonl", 1, null], b: "missing /private/tmp/herdr-conversation-x/case" }, folders))
      .toEqual({ a: ["$CASE/session.jsonl", 1, null], b: "missing $CASE" });
  });

  test("writes a failure as its error", async () => {
    const root = corpus({ "claude/case": { files: { "session.jsonl": SESSION }, spec: { steps: [page({ path: "missing.jsonl" }), page({ page: { before: "garbage" } })] } } });
    const { values: [missing, garbage] } = await runCase(loaded(root, "claude/case"));
    expect(missing).toEqual({ error: "ConversationUnavailable", reason: "transcript_missing" });
    expect(garbage).toEqual({ error: "HistoryChanged" });
  });
});

describe("case.json fields", () => {
  test("a field the format does not know fails the case, named", () => {
    expect(() => validateCase("claude/x", { steps: [page()], expect: 1 })).toThrow('claude/x: unknown field "expect"');
    expect(() => validateCase("claude/x", { steps: [page({ cursor: "c" })] })).toThrow('claude/x step 0: unknown field "cursor"');
    expect(() => validateCase("claude/x", { steps: [page({ page: { after: "c" } })] })).toThrow('claude/x step 0 page: unknown field "after"');
    expect(() => validateCase("claude/x", { steps: [{ append: "a", text: "x", mode: 1 }] })).toThrow('claude/x step 0: unknown field "mode"');
    expect(() => validateCase("claude/x", { steps: [{ api: { "/api/x": { status: 200, body: {}, headers: {} } } }] })).toThrow('unknown field "headers"');
    // a cwd is codex's alone
    expect(() => validateCase("claude/x", { steps: [{ call: "image", source: "claude", path: "a", ref: "r", cwd: "." }] })).toThrow('unknown field "cwd"');
    expect(() => validateCase("codex/x", { steps: [{ call: "image", source: "codex", path: "a", ref: "r", cwd: "." }] })).not.toThrow();
    expect(() => validateCase("pi/x", { steps: [{ call: "unansweredQuestions", source: "pi", path: "a" }] })).toThrow("only codex has unansweredQuestions");
    expect(() => validateCase("opencode/x", { steps: [{ call: "page", source: "opencode", path: "a" }] })).toThrow('unknown field "path"');
    expect(() => validateCase("pi/x", { steps: [page()], piContextWindows: { model: 1 } })).toThrow('"model" is not "<provider>/<model>"');
  });

  test("a case folder outside a source fails, named", () => {
    const root = corpus({ "gemini/x": { spec: { steps: [page()] } } });
    expect(() => loadCases(root)).toThrow("gemini: not a source");
  });
});

describe("OpenCode's recorded replies", () => {
  test("are looked up by the path with its query arguments sorted by name", async () => {
    expect(replyKey("/api/session/s/message?order=desc&limit=1")).toBe("/api/session/s/message?limit=1&order=desc");
    expect(replyKey("/api/session/s/message?limit=100&cursor=abc")).toBe("/api/session/s/message?cursor=abc&limit=100");
    expect(replyKey("/api/model")).toBe("/api/model");
    const api = new RecordedOpencodeApi({ serviceRunning: true, get: { "/api/x?b=2&a=1": { status: 200, body: { data: 1 } } } });
    expect(await api.get("/api/x?a=1&b=2")).toEqual({ data: 1 });
    expect(await api.serviceRunning()).toBe(true);
  });

  test("answer an error status as the CLI's HTTP error, and a path not recorded as the case's mistake", async () => {
    const api = new RecordedOpencodeApi({ serviceRunning: false, get: { "/api/x": { status: 404, body: { _tag: "SessionNotFoundError" } } } });
    const error = await api.get("/api/x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpencodeHttpError);
    expect(error).toMatchObject({ status: 404, tag: "SessionNotFoundError" });
    await expect(api.get("/api/y?z=1")).rejects.toThrow("api.json records no reply for GET /api/y?z=1");
    api.set({ "/api/x": { status: 200, body: "now" } });
    expect(await api.get("/api/x")).toBe("now");
  });

  test("an unrecorded GET fails the case, naming the path", async () => {
    const root = corpus({
      "opencode/case": {
        files: { "api.json": JSON.stringify({ serviceRunning: true, get: {} }) },
        spec: { steps: [{ call: "page", source: "opencode", sessionId: "ses_testsession0001" }] },
      },
    });
    await expect(runCase(loaded(root, "opencode/case"))).rejects.toThrow("opencode/case step 0: api.json records no reply for GET /api/session/ses_testsession0001");
  });
});
