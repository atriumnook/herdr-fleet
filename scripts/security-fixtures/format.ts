/**
 * The security decision tables: what the server's access, file, push and child-process decisions
 * return for inputs written as data (ADR 0122-parity-criteria, "安全上の判定の表").
 *
 * Each decision has one owner, the Rust crate that takes it over (core, child-process or
 * orchestrator), and one table: `fixtures/security/<owner>/<decision>.json`, a JSON array of cases.
 * A case is an object with exactly these fields:
 * - `about`: what the case shows. A case taken from a test names the test file and the test
 *   (`server/access.test.ts: decideAccess > ...`); a case added here says `added: ...`
 * - `input`: what the decision is given
 * - `expected`: what it returns
 *
 * Inputs and expected values are plain JSON, so that a runner in any language reads them alike:
 * - a header set is an array of `[name, value]` pairs. In `expected`, the names are lower case
 *   and the pairs are sorted by name
 * - a URL is a string
 * - an environment is an object from a variable's name to its value
 * - nothing is written as undefined: a field that is absent is left out, and a decision that
 *   returns nothing returns null
 * - in `expected`, the string `$GUARD_PLUGIN` stands for the folder of the OpenCode guard plugin
 *   (opencode/fleet-guard) of the checkout under test, which the runner puts in its place
 *
 * Objects are compared as JSON objects: the order of their fields does not count, the order of an
 * array's items does (OpenCode's rules, where the last match wins, are an array).
 *
 * The input and the expected value of each decision, by table:
 *
 * core
 * - decideAccess: an AccessInput (server/access.ts), `device` a `{id, label}` or null; the Access
 * - isLoopbackAddress, isLoopbackHost: the address or the Host header's value; a boolean
 * - cameThroughProxy: the request's headers; a boolean
 * - isAuthenticated: `{headers, token}`, the configured token ("" is none); a boolean
 * - requiresAuth: the request's path; a boolean
 * - sameOrigin: `{url, headers}`, the request's URL and headers; a boolean
 * - parseViewPath: the request's path; `{paneId, path}` (paneId null for `-`) or null
 * - fileResponseHeaders: `{file: {name, mime, kind}, download, page?}`, the file as fileInfo
 *   describes it (`kind` a FileKind of shared/protocol.ts), whether it is to be saved, and for a
 *   file read through its `/api/fs/view/` path the request's Host and pane, `{host, paneId}`
 *   (each may be null); the headers of fileResponse's answer, its body left out. content-type is
 *   as Bun writes it for the type fileResponse gives (Bun adds `;charset=utf-8` to text/html)
 * - isPushServiceEndpoint: the endpoint URL; a boolean
 * - parseSubscription: the JSON a browser sent as its subscription, the endpoint judged by
 *   isPushServiceEndpoint; the stored `{endpoint, keys: {p256dh, auth}}` or null
 *
 * child-process
 * - childEnv: `{env, alsoKeep?}`, the server's environment and the extra names to keep; the CLI's environment
 * - claudeEnv: the server's environment; claude's environment
 *
 * orchestrator
 * - opencodeGitEnv: the server's environment; the variables added to an OpenCode pane's environment
 * - opencodeConfig: an OpencodeRole (server/fleet/opencode-config.ts), `model` absent for none;
 *   the config object
 *
 * `scripts/security-fixtures/<owner>.ts` maps each decision of the owner to the server's function,
 * and `<owner>.test.ts` runs every case of the owner's tables, and fails when a table has no
 * decision or a decision no table. There is no script that writes expected values: to add a case,
 * write it into the table by hand. Its expected value is what the decision should return; when it
 * is copied from what the code returns now (a whole config or header set), read it against the
 * code and the tests before committing it.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OPENCODE_GUARD_PLUGIN } from "../../server/fleet/opencode-config.ts";

export const SECURITY_DIR = join(import.meta.dir, "..", "..", "fixtures", "security");

export type Owner = "core" | "child-process" | "orchestrator";
export type HeaderList = [string, string][];
export type Env = Record<string, string>;

export interface SecurityCase { about: string; input: unknown; expected: unknown }

/** a decision as a table runs it: from the case's input to a JSON value */
export type Decision = (input: never) => unknown;

/** The decisions that have a table under the owner's folder. */
export function tableNames(owner: Owner, root = SECURITY_DIR): string[] {
  return readdirSync(join(root, owner)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort();
}

function isHeaderList(value: unknown): boolean {
  return Array.isArray(value) && value.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string"));
}

/** A table's cases; a case that is not of the format above is an error, not a case that fails. */
export function loadTable(owner: Owner, decision: string, root = SECURITY_DIR): SecurityCase[] {
  const file = join(root, owner, `${decision}.json`);
  const cases = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`${file}: not a non-empty array of cases`);
  return cases.map((value, index) => {
    const where = `${file} case ${index}`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where}: not an object`);
    const fields = Object.keys(value).sort().join(",");
    if (fields !== "about,expected,input") throw new Error(`${where}: has the fields ${fields}, not about, input and expected`);
    const spec = value as SecurityCase;
    if (typeof spec.about !== "string" || spec.about === "") throw new Error(`${where}: about is not a text`);
    return spec;
  });
}

/** The headers of a request, from a table's pairs. */
export function headersOf(list: unknown): Headers {
  if (!isHeaderList(list)) throw new Error(`not a list of [name, value] pairs: ${JSON.stringify(list)}`);
  return new Headers(list as HeaderList);
}

/** A response's headers as a table writes them: names in lower case, sorted by name. */
export function headerList(headers: Headers): HeaderList {
  return [...headers].map(([name, value]): [string, string] => [name.toLowerCase(), value]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

/** An expected value with the checkout's own paths put in for their placeholders. */
export function resolvePlaceholders(value: unknown): unknown {
  if (value === "$GUARD_PLUGIN") return OPENCODE_GUARD_PLUGIN;
  if (Array.isArray(value)) return value.map(resolvePlaceholders);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePlaceholders(item)]));
  return value;
}

/** What a decision returns, as JSON reads it back: a field set to undefined is gone, as in a table. */
export function run(decision: Decision, input: unknown): unknown {
  const value = (decision as (input: unknown) => unknown)(input);
  return value === undefined ? null : JSON.parse(JSON.stringify(value)) as unknown;
}

/** The tests of one owner: its tables are exactly its decisions, and every case returns what it expects. */
export function testOwner(owner: Owner, decisions: Record<string, Decision>): void {
  test(`${owner}: a table for each decision, and a decision for each table`, () => {
    expect(tableNames(owner)).toEqual(Object.keys(decisions).sort());
  });
  for (const [name, decision] of Object.entries(decisions)) {
    for (const [index, spec] of loadTable(owner, name).entries()) {
      test(`${owner}/${name} #${index}: ${spec.about}`, () => {
        expect(run(decision, spec.input)).toStrictEqual(resolvePlaceholders(spec.expected));
      });
    }
  }
}
