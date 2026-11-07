/**
 * The conversation corpus: what the transcript readers return for the conversation logs the
 * agents write (ADR 0122-parity-criteria, "会話ログの corpus").
 *
 * Each case is a folder `fixtures/conversations/<source>/<case>/`, `<source>` one of claude,
 * codex, pi, omp and opencode, holding
 * - the input files: transcripts (`*.jsonl`), a Codex home (`codex-home/sessions/<y>/<m>/<d>/…`),
 *   the files of later steps, and for OpenCode the recorded replies `api.json`. All of them are
 *   written in the likeness of the tests they came from, never copied from a real session
 * - `case.json`, a JSON object of these fields and no others (a field this script does not know
 *   fails the case, naming it):
 *   - `about`: what the case shows, and the test file and test name it was recorded from
 *   - `piContextWindows`: `{"<provider>/<model>": <tokens>}`, the context windows pi's model
 *     catalog states. Written to a `models.json` that `PI_CODING_AGENT_DIR` points at for the
 *     case; without the field the catalog is empty, never the machine's own
 *   - `steps`: run in order, each one an object of one of these forms
 *     - a call, with what it returns in `expected`:
 *       - `{"call": "page", "source", "path", "page"?: {"before"?, "since"?, "from"?}}`: one page of
 *         the conversation (transcriptPage), metadata included. For opencode
 *         `{"call": "page", "source": "opencode", "sessionId", "working"?, "page"?}`
 *         (OpencodeConversations.page; `working` is herdr's word that the pane is busy, false
 *         when left out)
 *       - `{"call": "image", "source", "path", "ref"}`: a pasted image (claude: transcriptImage, pi:
 *         piTranscriptImage). codex also takes `cwd`, the folder a local image's relative path
 *         starts from, relative to the case folder (codexTranscriptImage). opencode takes
 *         `sessionId` and `ref`
 *       - `{"call": "toolOutput", "source", "path", "ref"}`: a tool call's whole output
 *         (transcriptToolOutput). opencode takes `sessionId` and `ref`
 *       - `{"call": "unansweredQuestions", "source": "codex", "path"}`: the questions a Codex rollout
 *         holds no answer for (unansweredCodexQuestions)
 *     - a change to a file of the case, its new bytes from `from` (a file of the case folder) or
 *       `text` (written as UTF-8):
 *       - `{"append": "<path>", "from" | "text"}`: added at the end
 *       - `{"replace": "<path>", "from" | "text"}`: another file (another inode) put in its place
 *       - `{"rewrite": "<path>", "from" | "text"}`: written over in place (the same inode), its
 *         mtime then set one second past the one it had: the readers find a rewrite by the size,
 *         mtime and ctime, and two writes can share one mtime tick
 *       - `{"remove": "<path>"}`
 *     - `{"api": {"<path>": {"status", "body"}}}`: OpenCode's replies for these GET paths change
 *       to these from here on, the others stay as recorded
 *     - `{"at": <ms>}`: the time OpenCode's reader is given as now from here on (0 until then)
 *
 * Paths in a case are relative to the case's own folder. A codex call reads the Codex home
 * `codex-home` of the case (absent unless the case has one). `api.json` is
 * `{"serviceRunning": <bool>, "get": {"<path>": {"status", "body"}}}`: the recorded replies of
 * the CLI's `opencode api GET <path>`, the status code with each, since a 404 and a 400 mean
 * different things to the reader. A path's query arguments are sorted by name, both in the keys
 * and in the path a reader asks for, so their order names no other reply; a GET of a path not
 * recorded fails the case, naming the path.
 *
 * How a case is run: a new temporary folder (`$CASE`) for each case, the case folder's files
 * (but case.json) copied into it byte for byte, forgetTranscriptState, forgetHistoryChains and
 * forgetPiModels called, and the steps run in order against one state (the module caches here,
 * one `Transcripts` value in Rust), and one OpencodeConversations for the case's opencode calls.
 *
 * What a call returns, as `expected` holds it:
 * - the value as JSON reads it back (a field left undefined is left out, undefined is null)
 * - the temporary folder's path, wherever it appears in a string, written `$CASE`
 * - an image `{"mediaType", "sha256", "length"}` (sha256 in hex), or null
 * - a failure `{"error": "HistoryChanged"}`, `{"error": "ConversationUnavailable", "reason"}`,
 *   `{"error": "ConversationNotStarted", "reason", "sessionId", "source", "identity"}`; any other
 *   failure fails the case
 * - in a page, `history_id`, a `cursor` that is not null and `version` are not written as
 *   values: they are new in every run (the file's dev and ino, a random id after a rewrite, a
 *   hash of the absolute path of an earlier rollout, a random id of the process). `"$<name>"`
 *   names the value where it first appears, and says the value is the one so named everywhere
 *   after. Two names never name the same value. `"!$<name>"` says the value is another than the
 *   one so named. A later step's `page.before`, `since` and `from` can be `"$<name>"`. An
 *   opencode page's `history_id` and `cursor` are the recorded message ids, the same in every
 *   run, and are written as values; only its `version` is named. Names hold within one case:
 *   no case names another case's values
 *
 * server/conversation-fixtures.test.ts checks every case, and every case again in the reverse
 * order. To add one, put its files and a case.json whose call steps have no `expected` in a new
 * folder, then run
 *
 *     bun scripts/conversation-fixtures.ts --update
 *
 * which writes what the code returns now into the cases that have a call without an expected
 * value, and names the values that change with every run `$h`, `$h2`… (history_id), `$c1`, `$c2`…
 * (cursor) and `$v1`, `$v2`… (version), in the order they appear. A name the case already gives
 * to a value, in its steps' inputs or in an expected value being rewritten, is kept. A case whose
 * calls all have expected values is left as it is: a failing case is a question of whether the
 * code or the case is wrong, not something to write over. To rewrite cases the code now rightly
 * answers differently, name them:
 *
 *     bun scripts/conversation-fixtures.ts --update claude/some-case codex/another
 *
 * Read the diff before committing it. Fields of case.json this script does not write are kept.
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { codexHistorySegments, forgetHistoryChains, unansweredCodexQuestions } from "../server/codex.ts";
import { codexTranscriptImage } from "../server/codex-images.ts";
import { ConversationUnavailable, HistoryChanged } from "../server/conversation-errors.ts";
import { ConversationNotStarted, forgetTranscriptState, piTranscriptImage, transcriptImage, transcriptPage, transcriptToolOutput, type ConversationPage } from "../server/conversation.ts";
import { OpencodeHttpError, type OpencodeApi } from "../server/opencode-cli.ts";
import { OpencodeConversations } from "../server/opencode-session.ts";
import { forgetPiModels } from "../server/pi-models.ts";

export const CONVERSATIONS_DIR = join(import.meta.dir, "..", "fixtures", "conversations");

export const SOURCES = ["claude", "codex", "pi", "omp", "opencode"] as const;
export type Source = typeof SOURCES[number];
type FileSource = Exclude<Source, "opencode">;
const TRANSCRIPT_SOURCE = { claude: "claude-transcript", codex: "codex-transcript", pi: "pi-transcript", omp: "omp-transcript" } as const;

export const CALLS = ["page", "image", "toolOutput", "unansweredQuestions"] as const;
export type Call = typeof CALLS[number];

/** a recorded reply of `opencode api GET <path>` */
export interface Reply { status: number; body: unknown }

export interface CallStep {
  call: Call;
  source: Source;
  path?: string;
  sessionId?: string;
  working?: boolean;
  page?: ConversationPage;
  ref?: string;
  cwd?: string;
  expected?: unknown;
}

export type Step =
  | CallStep
  | { append: string; from?: string; text?: string }
  | { replace: string; from?: string; text?: string }
  | { rewrite: string; from?: string; text?: string }
  | { remove: string }
  | { api: Record<string, Reply> }
  | { at: number };

export interface ConversationCase {
  about?: string;
  piContextWindows?: Record<string, number>;
  steps: Step[];
}

export interface LoadedCase { name: string; dir: string; spec: ConversationCase }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The keys of `value` that are not `allowed`, as an error naming them; nothing when there are none. */
function onlyKeys(where: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${where}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((key) => `"${key}"`).join(", ")}`);
}

const CALL_FIELDS: Record<"file" | "opencode", Record<Call, readonly string[]>> = {
  file: {
    page: ["call", "source", "path", "page", "expected"],
    image: ["call", "source", "path", "ref", "expected"],
    toolOutput: ["call", "source", "path", "ref", "expected"],
    unansweredQuestions: ["call", "source", "path", "expected"],
  },
  opencode: {
    page: ["call", "source", "sessionId", "working", "page", "expected"],
    image: ["call", "source", "sessionId", "ref", "expected"],
    toolOutput: ["call", "source", "sessionId", "ref", "expected"],
    unansweredQuestions: [],
  },
};

const FILE_STEPS = ["append", "replace", "rewrite"] as const;

/** Throws, naming the field, when case.json holds anything this format does not say. */
export function validateCase(name: string, value: unknown): ConversationCase {
  if (!isRecord(value)) throw new Error(`${name}: case.json is not an object`);
  onlyKeys(name, value, ["about", "piContextWindows", "steps"]);
  if (value["about"] !== undefined && typeof value["about"] !== "string") throw new Error(`${name}: "about" is not a string`);
  const windows = value["piContextWindows"];
  if (windows !== undefined) {
    if (!isRecord(windows)) throw new Error(`${name}: "piContextWindows" is not an object`);
    for (const [key, tokens] of Object.entries(windows)) {
      if (!/^[^/]+\/.+$/.test(key)) throw new Error(`${name}: piContextWindows key "${key}" is not "<provider>/<model>"`);
      if (typeof tokens !== "number" || !Number.isSafeInteger(tokens)) throw new Error(`${name}: piContextWindows "${key}" is not a whole number`);
    }
  }
  if (!Array.isArray(value["steps"]) || value["steps"].length === 0) throw new Error(`${name}: "steps" is not a list of steps`);
  value["steps"].forEach((step, index) => validateStep(`${name} step ${index}`, step));
  return value as unknown as ConversationCase;
}

function validateStep(where: string, step: unknown): void {
  if (!isRecord(step)) throw new Error(`${where}: not an object`);
  if ("call" in step) {
    const call = step["call"];
    if (!CALLS.includes(call as Call)) throw new Error(`${where}: unknown call ${JSON.stringify(call)}`);
    const source = step["source"];
    if (!SOURCES.includes(source as Source)) throw new Error(`${where}: unknown source ${JSON.stringify(source)}`);
    const fields = source === "opencode" ? CALL_FIELDS.opencode[call as Call] : [...CALL_FIELDS.file[call as Call], ...(source === "codex" && call === "image" ? ["cwd"] : [])];
    if (fields.length === 0) throw new Error(`${where}: opencode has no ${String(call)} call`);
    if (call === "unansweredQuestions" && source !== "codex") throw new Error(`${where}: only codex has unansweredQuestions`);
    if (call === "image" && source === "omp") throw new Error(`${where}: omp has no image call`);
    onlyKeys(where, step, fields);
    for (const field of fields) {
      if (field === "expected" || field === "page" || field === "working") continue;
      if (typeof step[field] !== "string") throw new Error(`${where}: "${field}" is not a string`);
    }
    if (step["working"] !== undefined && typeof step["working"] !== "boolean") throw new Error(`${where}: "working" is not a boolean`);
    const page = step["page"];
    if (page !== undefined) {
      if (!isRecord(page)) throw new Error(`${where}: "page" is not an object`);
      onlyKeys(`${where} page`, page, ["before", "since", "from"]);
      for (const [key, cursor] of Object.entries(page)) if (typeof cursor !== "string") throw new Error(`${where}: page "${key}" is not a string`);
    }
    return;
  }
  const kinds = [...FILE_STEPS, "remove", "api", "at"].filter((kind) => kind in step);
  if (kinds.length !== 1) throw new Error(`${where}: a step is one of call, ${[...FILE_STEPS, "remove", "api", "at"].join(", ")} (fields: ${Object.keys(step).join(", ") || "none"})`);
  const kind = kinds[0]!;
  if ((FILE_STEPS as readonly string[]).includes(kind)) {
    onlyKeys(where, step, [kind, "from", "text"]);
    if (typeof step[kind] !== "string") throw new Error(`${where}: "${kind}" is not a path`);
    if ((step["from"] === undefined) === (step["text"] === undefined)) throw new Error(`${where}: ${kind} takes one of "from" and "text"`);
    if (step["from"] !== undefined && typeof step["from"] !== "string") throw new Error(`${where}: "from" is not a path`);
    if (step["text"] !== undefined && typeof step["text"] !== "string") throw new Error(`${where}: "text" is not a string`);
  } else if (kind === "remove") {
    onlyKeys(where, step, ["remove"]);
    if (typeof step["remove"] !== "string") throw new Error(`${where}: "remove" is not a path`);
  } else if (kind === "api") {
    onlyKeys(where, step, ["api"]);
    validateReplies(`${where} api`, step["api"]);
  } else {
    onlyKeys(where, step, ["at"]);
    if (typeof step["at"] !== "number" || !Number.isFinite(step["at"])) throw new Error(`${where}: "at" is not a number`);
  }
}

function validateReplies(where: string, replies: unknown): void {
  if (!isRecord(replies)) throw new Error(`${where}: not an object of paths`);
  for (const [path, reply] of Object.entries(replies)) {
    if (!path.startsWith("/")) throw new Error(`${where}: "${path}" is not a path`);
    if (!isRecord(reply)) throw new Error(`${where} "${path}": not {status, body}`);
    onlyKeys(`${where} "${path}"`, reply, ["status", "body"]);
    if (typeof reply["status"] !== "number" || !Number.isInteger(reply["status"])) throw new Error(`${where} "${path}": "status" is not a whole number`);
    if (!("body" in reply)) throw new Error(`${where} "${path}": no "body"`);
  }
}

export function loadCases(root = CONVERSATIONS_DIR): LoadedCase[] {
  const folders = (path: string) => readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return folders(root).flatMap((source) => {
    if (!SOURCES.includes(source as Source)) throw new Error(`${source}: not a source (${SOURCES.join(", ")})`);
    return folders(join(root, source)).map((folder) => {
      const name = `${source}/${folder}`;
      const dir = join(root, source, folder);
      return { name, dir, spec: validateCase(name, JSON.parse(readFileSync(join(dir, "case.json"), "utf8"))) };
    });
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** A path with its query arguments sorted by name: the key a reply is recorded under. */
export function replyKey(path: string): string {
  const mark = path.indexOf("?");
  if (mark < 0) return path;
  const query = path.slice(mark + 1).split("&").filter(Boolean).map((pair, index) => ({ name: pair.split("=")[0]!, pair, index }));
  // by name, and arguments of one name in the order given (their order means something)
  query.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index);
  return `${path.slice(0, mark)}?${query.map(({ pair }) => pair).join("&")}`;
}

/** OpenCode's recorded replies (`api.json`), as the CLI would answer them; a path not recorded fails. */
export class RecordedOpencodeApi implements OpencodeApi {
  private readonly replies = new Map<string, Reply>();
  private readonly running: boolean;

  constructor(recorded: unknown, where = "api.json") {
    if (!isRecord(recorded)) throw new Error(`${where}: not an object`);
    onlyKeys(where, recorded, ["serviceRunning", "get"]);
    if (typeof recorded["serviceRunning"] !== "boolean") throw new Error(`${where}: "serviceRunning" is not a boolean`);
    this.running = recorded["serviceRunning"];
    this.set(recorded["get"] ?? {}, `${where} get`);
  }

  /** replaces the replies of these paths (the `api` step) */
  set(replies: unknown, where = "api"): void {
    validateReplies(where, replies);
    const keys = new Set<string>();
    for (const [path, reply] of Object.entries(replies as Record<string, Reply>)) {
      const key = replyKey(path);
      if (keys.has(key)) throw new Error(`${where}: "${path}" names the same reply as another path`);
      keys.add(key);
      this.replies.set(key, reply);
    }
  }

  async serviceRunning(): Promise<boolean> { return this.running; }

  async get(path: string): Promise<unknown> {
    const reply = this.replies.get(replyKey(path));
    if (reply === undefined) throw new UnrecordedPath(replyKey(path));
    if (reply.status >= 200 && reply.status < 300) return structuredClone(reply.body);
    const tag = isRecord(reply.body) && typeof reply.body["_tag"] === "string" ? reply.body["_tag"] : "";
    throw new OpencodeHttpError(reply.status, tag);
  }
}

/** A GET the case did not record: the case is wrong, not the reader. */
class UnrecordedPath extends Error {
  constructor(path: string) {
    super(`api.json records no reply for GET ${path}`);
    this.name = "UnrecordedPath";
  }
}

/** The names a case gives to the values that change with every run. */
export class Names {
  private readonly byName = new Map<string, string>();
  private readonly byValue = new Map<string, string>();

  value(name: string): string | undefined { return this.byName.get(name); }
  nameOf(value: string): string | undefined { return this.byValue.get(value); }

  bind(name: string, value: string): void {
    this.byName.set(name, value);
    this.byValue.set(value, name);
  }

  /** the next unused name of a kind: `$h`, `$h2`…, `$c1`, `$c2`…, `$v1`, `$v2`… */
  next(prefix: "h" | "c" | "v"): string {
    for (let n = 1; ; n += 1) {
      const name = prefix === "h" && n === 1 ? "$h" : `$${prefix}${n}`;
      if (!this.byName.has(name)) return name;
    }
  }
}

const NAME = /^\$[A-Za-z_][A-Za-z0-9_]*$/;
const NOT_NAME = /^!\$[A-Za-z_][A-Za-z0-9_]*$/;
const NAMED_FIELDS = { history_id: "h", cursor: "c", version: "v" } as const;

/**
 * Writes a value that changes with every run as the case holds it. Checking (`update` false), a
 * name the expected value gives is bound or compared, and a value that does not fit its name is
 * left as it is, so the comparison shows it. Updating, the value takes the name it already has,
 * else the name the old expected value gives it, else the next unused one.
 */
function nameValue(actual: unknown, field: keyof typeof NAMED_FIELDS, expected: unknown, names: Names, update: boolean): unknown {
  if (typeof actual !== "string") return actual;
  if (update) {
    const known = names.nameOf(actual);
    if (known !== undefined) return known;
    const name = typeof expected === "string" && NAME.test(expected) && expected !== "$CASE" && names.value(expected) === undefined ? expected : names.next(NAMED_FIELDS[field]);
    names.bind(name, actual);
    return name;
  }
  if (typeof expected !== "string") return actual;
  if (NOT_NAME.test(expected)) {
    const other = names.value(expected.slice(1));
    return other !== undefined && other !== actual ? expected : actual;
  }
  if (!NAME.test(expected) || expected === "$CASE") return actual;
  const bound = names.value(expected);
  if (bound !== undefined) return bound === actual ? expected : actual;
  // two names never name one value
  if (names.nameOf(actual) !== undefined) return actual;
  names.bind(expected, actual);
  return expected;
}

/** Every string in `value` with the case folder's path written `$CASE` (`folders`: its spellings, the longest first). */
export function withCase(value: unknown, folders: string[]): unknown {
  if (typeof value === "string") return folders.reduce((text, folder) => text.split(folder).join("$CASE"), value);
  if (Array.isArray(value)) return value.map((item) => withCase(item, folders));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withCase(item, folders)]));
  return value;
}

function failure(error: unknown): unknown {
  if (error instanceof HistoryChanged) return { error: "HistoryChanged" };
  if (error instanceof ConversationNotStarted) return { error: "ConversationNotStarted", reason: error.message, sessionId: error.sessionId, source: error.source, identity: error.identity };
  if (error instanceof ConversationUnavailable) return { error: "ConversationUnavailable", reason: error.message };
  throw error;
}

function image(found: { mediaType: string; bytes: Uint8Array } | null): unknown {
  return found === null ? null : { mediaType: found.mediaType, sha256: createHash("sha256").update(found.bytes).digest("hex"), length: found.bytes.length };
}

/** A cursor the case passes: a name it gave before, or a value as written. */
function input(cursor: string, names: Names, where: string): string {
  if (!NAME.test(cursor)) return cursor;
  const value = names.value(cursor);
  if (value === undefined) throw new Error(`${where}: ${cursor} is passed before a step names it`);
  return value;
}

/** A path of the case, inside its folder. */
function inside(folder: string, path: string, where: string): string {
  const full = resolve(folder, path);
  if (full !== folder && !full.startsWith(`${folder}/`)) throw new Error(`${where}: "${path}" is outside the case folder`);
  return full;
}

/** Copies a folder's files, but case.json at its top, byte for byte. */
function copyCase(from: string, to: string, top = true): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (top && entry.name === "case.json") continue;
    if (entry.isDirectory()) copyCase(join(from, entry.name), join(to, entry.name), false);
    else if (entry.isFile()) copyFileSync(join(from, entry.name), join(to, entry.name));
    else throw new Error(`${join(from, entry.name)}: neither a file nor a folder`);
  }
}

export interface Ran {
  /** per step: what a call returned, as the case writes it; undefined for the steps that are no call */
  values: unknown[];
}

/**
 * Runs a case in a new temporary folder. Checking, the values come out as the case writes them
 * when they match it; updating (`update`), every value that changes with every run is named.
 */
export async function runCase({ name, dir, spec }: LoadedCase, options: { update?: boolean } = {}): Promise<Ran> {
  const update = options.update === true;
  const root = mkdtempSync(join(tmpdir(), "herdr-conversation-"));
  const folder = join(root, "case");
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  try {
    copyCase(dir, folder);
    const folders = [...new Set([folder, realpathSync(folder)])].sort((a, b) => b.length - a.length);
    // pi's model catalog: the case's own, never the machine's
    const agentDir = join(root, "pi-agent");
    mkdirSync(agentDir);
    if (spec.piContextWindows !== undefined) {
      const providers: Record<string, { models: { id: string; contextWindow: number }[] }> = {};
      for (const [key, contextWindow] of Object.entries(spec.piContextWindows)) {
        const slash = key.indexOf("/");
        (providers[key.slice(0, slash)] ??= { models: [] }).models.push({ id: key.slice(slash + 1), contextWindow });
      }
      writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }));
    }
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    forgetTranscriptState();
    forgetHistoryChains();
    forgetPiModels();

    let now = 0;
    let api: RecordedOpencodeApi | undefined;
    let opencode: OpencodeConversations | undefined;
    const openCode = (where: string): { api: RecordedOpencodeApi; reader: OpencodeConversations } => {
      if (api === undefined) {
        let recorded: unknown;
        try { recorded = JSON.parse(readFileSync(join(dir, "api.json"), "utf8")); } catch (error) { throw new Error(`${where}: the case has no readable api.json (${String(error)})`); }
        api = new RecordedOpencodeApi(recorded, `${name}/api.json`);
        opencode = new OpencodeConversations(api, () => now);
      }
      return { api, reader: opencode! };
    };
    const names = new Names();
    const values: unknown[] = [];
    for (const [index, step] of spec.steps.entries()) {
      const where = `${name} step ${index}`;
      if ("call" in step) {
        let value: unknown;
        try { value = await call(step, folder, names, where, openCode); }
        catch (error) {
          if (error instanceof UnrecordedPath) throw new Error(`${where}: ${error.message}`);
          value = failure(error);
        }
        value = withCase(JSON.parse(JSON.stringify(value ?? null)) as unknown, folders);
        if (step.call === "page" && isRecord(value) && !("error" in value)) {
          const expected = isRecord(step.expected) ? step.expected : {};
          for (const field of Object.keys(NAMED_FIELDS) as (keyof typeof NAMED_FIELDS)[]) {
            // OpenCode's history id and cursors are message ids, the same in every run
            if (step.source === "opencode" && field !== "version") continue;
            if (field in value && value[field] !== null) value[field] = nameValue(value[field], field, expected[field], names, update);
          }
        }
        values.push(value);
        continue;
      }
      values.push(undefined);
      if ("at" in step) { now = step.at; continue; }
      if ("api" in step) { openCode(where).api.set(step.api, `${where} api`); continue; }
      if ("remove" in step) { unlinkSync(inside(folder, step.remove, where)); continue; }
      const [kind, path] = "append" in step ? ["append", step.append] : "replace" in step ? ["replace", step.replace] : ["rewrite", step.rewrite];
      const target = inside(folder, path, where);
      const bytes = step.from !== undefined ? readFileSync(inside(dir, step.from, where)) : Buffer.from(step.text!, "utf8");
      if (kind === "append") appendFileSync(target, bytes);
      else if (kind === "replace") {
        const next = join(dirname(target), `.replace-${index}`);
        writeFileSync(next, bytes);
        renameSync(next, target);
      } else {
        const before = statSync(target);
        writeFileSync(target, bytes);
        const at = before.mtimeMs / 1000 + 1;
        utimesSync(target, at, at);
      }
    }
    return { values };
  } finally {
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    forgetPiModels();
    rmSync(root, { recursive: true, force: true });
  }
}

async function call(step: CallStep, folder: string, names: Names, where: string, openCode: (where: string) => { reader: OpencodeConversations }): Promise<unknown> {
  const page: ConversationPage | undefined = step.page === undefined ? undefined
    : Object.fromEntries(Object.entries(step.page).map(([key, cursor]) => [key, input(cursor, names, `${where} page.${key}`)]));
  if (step.source === "opencode") {
    const { reader } = openCode(where);
    switch (step.call) {
      case "page": return reader.page(step.sessionId!, step.working ?? false, page);
      case "image": return image(await reader.image(step.sessionId!, step.ref!));
      case "toolOutput": return reader.toolOutput(step.sessionId!, step.ref!);
      default: throw new Error(`${where}: opencode has no ${step.call} call`);
    }
  }
  const source = step.source as FileSource;
  const path = inside(folder, step.path!, where);
  // a codex call reads the case's own Codex home, whether or not the case has one
  const codexHome = join(folder, "codex-home");
  switch (step.call) {
    case "page": return transcriptPage(TRANSCRIPT_SOURCE[source], path, page, codexHome);
    case "toolOutput": return transcriptToolOutput(TRANSCRIPT_SOURCE[source], path, step.ref!, codexHome);
    case "image":
      if (source === "claude") return image(transcriptImage(path, step.ref!));
      if (source === "pi") return image(piTranscriptImage(path, step.ref!));
      if (source === "codex") return image(await codexTranscriptImage(codexHistorySegments(path, codexHome), step.ref!, inside(folder, step.cwd!, where)));
      throw new Error(`${where}: ${source} has no image call`);
    case "unansweredQuestions":
      if (source !== "codex") throw new Error(`${where}: only codex has unansweredQuestions`);
      return unansweredCodexQuestions(path);
  }
}

/** A call step without an expected value. */
const unfilled = (spec: ConversationCase): boolean => spec.steps.some((step) => "call" in step && step.expected === undefined);

/**
 * Writes what the code returns now into the cases that have a call without an expected value
 * and into the cases `names` names, and nothing else. Returns the cases written.
 */
export async function update(names: string[] = [], root = CONVERSATIONS_DIR): Promise<string[]> {
  const cases = loadCases(root);
  const known = new Set(cases.map(({ name }) => name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`no such case: ${unknown.join(", ")}`);
  const targets = new Set([...names, ...cases.filter(({ spec }) => unfilled(spec)).map(({ name }) => name)]);
  for (const loaded of cases) {
    if (!targets.has(loaded.name)) continue;
    const { values } = await runCase(loaded, { update: true });
    const steps = loaded.spec.steps.map((step, index) => "call" in step ? { ...step, expected: values[index] } : step);
    writeFileSync(join(loaded.dir, "case.json"), `${JSON.stringify({ ...loaded.spec, steps }, null, 2)}\n`);
  }
  return [...targets].sort();
}

if (import.meta.main) {
  const [flag, ...names] = process.argv.slice(2);
  if (flag !== "--update") {
    console.error("Usage: bun scripts/conversation-fixtures.ts --update [<source>/<case> ...]");
    process.exit(2);
  }
  const written = await update(names);
  console.log(written.length ? `wrote ${written.length} cases:\n${written.join("\n")}` : "every case has its expected values: name the cases to rewrite");
}
