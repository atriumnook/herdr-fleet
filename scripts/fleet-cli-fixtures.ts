/**
 * The fleet CLI contract: what the `fleet` command sends to the fleet server, prints and exits with,
 * for given arguments, environment and server answers (ADR 0122-parity-criteria, "fleet CLI の契約").
 *
 * Each case is a file `fixtures/fleet-cli/<case>.json` holding
 * - `about`: what the case shows, or the test it was recorded from
 * - `argv`: the arguments after `fleet`
 * - `env`: environment variables for the CLI (optional). The runner builds the CLI's environment from
 *   nothing: `PATH`, `HOME` and `TMPDIR` of the test's process, `TZ=UTC`, `LANG=en_US.UTF-8`, then
 *   these. No `HERDR_*` or `LC_*` of the test's process reaches the CLI. A case may not set
 *   `HERDR_FLEET_URL` (the runner points it at the stub; without it the CLI would send to the running
 *   fleet on port 7317), the five names above, or any `LC_*`
 * - `trailingSlash`: true to give `HERDR_FLEET_URL` with a trailing `/` (optional)
 * - `stdin`: what the CLI reads on its standard input, for `fleet plan -` (optional; else none)
 * - `files`: files written into the CLI's working folder before it starts, name to text, for
 *   `fleet plan <file>` (optional)
 * - `responses`: what the stub server answers, one per request in the order they come, as
 *   `{ "status": <code>, "body": <JSON value, or a string sent as text> }`. A request past the last
 *   answer gets a 500 with the error code `no_response`, and shows in the requests compared below
 * - `server`: `"closed"` for a case where no server listens: the URL then names a port from
 *   7400 to 7499 that nothing listens on (optional, and leaves out `responses`)
 * - `expected`, written by `--update` from what the CLI does now:
 *   - `requests`: each request the stub received, in order, as `method`, `path` (with the query, from
 *     `/api/fleet`), `headers` (only `x-herdr-fleet` and `authorization`, when sent) and `body` (the
 *     JSON it sent; left out when it sent none)
 *   - `stdout`, `stderr`: the text the CLI wrote
 *   - `exitCode`
 *
 * Values that change from run to run are written as placeholders, in what the CLI prints and sends:
 * - `$URL`: the stub's URL, `http://127.0.0.1:<port>`, with no trailing `/`
 * - `$CWD`: the CLI's working folder, a new empty folder for each case (in a request's `path`, its
 *   percent-encoded form, as encodeURIComponent writes it)
 *
 * `stdout` and `stderr` are compared whole. Where the text comes from the runtime rather than the CLI
 * (the message of a failed connection, of an unknown option, of a file that cannot be read), write
 * `{ "pattern": "<regular expression>" }` by hand instead: it must match the whole text, with the
 * placeholders already put in (so `\\$URL`). Times are formatted with toLocaleString in the fixed
 * environment above; write them ten or more years from now, so whether a cooldown shows does not
 * depend on when the test runs.
 *
 * The CLI under test is chosen with `HERDR_FLEET_CLI_TARGET`: `ts` (the default) runs
 * `bun bin/fleet.ts`, `rust:<path>` runs the executable at that path.
 *
 * bin/fleet-cli-fixtures.test.ts checks every case. To add one, write its file without `expected`,
 * then run
 *
 *     bun scripts/fleet-cli-fixtures.ts --update
 *
 * which writes what the CLI does now into the cases that have no expected value yet. A case that has
 * one is left as it is: a failing case is a question of whether the CLI or the case is wrong. To
 * rewrite cases the CLI now rightly answers differently, name them (a `pattern` that still matches is
 * kept):
 *
 *     bun scripts/fleet-cli-fixtures.ts --update spawn-task wait-timeout
 *
 * Without `--update` it runs every case, or the named ones, and prints each that fails.
 * `--update` refuses a case whose CLI made more or fewer requests than it has responses, and a run
 * killed after RUN_LIMIT_MS fails its case. Read the diff before committing it. Fields of a case this
 * script does not write are kept.
 */
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const CASES_DIR = join(import.meta.dir, "..", "fixtures", "fleet-cli");
const TS_CLI = join(import.meta.dir, "..", "bin", "fleet.ts");
const PORTS = { first: 7400, last: 7499 } as const;
/** how long a run of the CLI may take before it is killed and the case fails; the test's own timeout is longer */
export const RUN_LIMIT_MS = 10_000;
/** names the runner sets itself; a case's env may not change them */
const RUNNER_ENV = ["HERDR_FLEET_URL", "PATH", "HOME", "TMPDIR", "TZ", "LANG"];

export type Output = string | { pattern: string };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: { "x-herdr-fleet"?: string; authorization?: string };
  body?: unknown;
}

export interface Expected { requests: RecordedRequest[]; stdout: Output; stderr: Output; exitCode: number }

export interface FleetCliCase {
  about: string;
  argv: string[];
  env?: Record<string, string>;
  trailingSlash?: boolean;
  stdin?: string;
  files?: Record<string, string>;
  responses?: Array<{ status: number; body?: unknown }>;
  server?: "closed";
  expected?: Expected;
}

export interface LoadedCase { name: string; file: string; spec: FleetCliCase }

/** What a run of the CLI did, with the placeholders put in. */
export interface Actual { requests: RecordedRequest[]; stdout: string; stderr: string; exitCode: number }

export function loadCases(root = CASES_DIR): LoadedCase[] {
  return readdirSync(root).filter((name) => name.endsWith(".json")).sort().map((entry) => {
    const file = join(root, entry);
    return { name: basename(entry, ".json"), file, spec: JSON.parse(readFileSync(file, "utf8")) as FleetCliCase };
  });
}

/** The command line that starts the CLI `value` names (HERDR_FLEET_CLI_TARGET); throws when it cannot start. */
export function resolveTarget(value = process.env["HERDR_FLEET_CLI_TARGET"] || "ts"): string[] {
  if (value === "ts") return [process.execPath, TS_CLI];
  if (value.startsWith("rust:") && value.length > "rust:".length) {
    const path = value.slice("rust:".length);
    let problem: string | undefined;
    try {
      if (!statSync(path).isFile()) problem = "is not a file";
      else accessSync(path, constants.X_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      problem = code === "ENOENT" ? "was not found" : code === "EACCES" ? "is not executable" : String(error);
    }
    if (problem) throw new Error(`HERDR_FLEET_CLI_TARGET=${value}: the executable ${path} ${problem}`);
    // the CLI starts in a folder of its own, so a relative path is resolved here
    return [resolve(path)];
  }
  throw new Error(`HERDR_FLEET_CLI_TARGET=${value}: give ts, or rust:<path to the executable>`);
}

function checkCase(spec: FleetCliCase): void {
  for (const key of Object.keys(spec.env ?? {})) {
    if (RUNNER_ENV.includes(key) || key.startsWith("LC_")) throw new Error(`the case may not set ${key}; the runner sets the CLI's environment`);
  }
  if (spec.server === "closed" && spec.responses?.length) throw new Error("a case with \"server\": \"closed\" has no responses");
}

/** Puts `replace` for every `find` in the strings of a JSON value. */
function substitute(value: unknown, pairs: Array<[string, string]>): unknown {
  if (typeof value === "string") return pairs.reduce((text, [find, replace]) => text.split(find).join(replace), value);
  if (Array.isArray(value)) return value.map((item) => substitute(item, pairs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, pairs)]));
  return value;
}

type Stub = { port: number; requests: RecordedRequest[]; stop: () => Promise<void> };

/** Calls `listen` on ports from 7400 to 7499, starting at a random one, until one is free. */
function onFreePort<T>(listen: (port: number) => T): T {
  const count = PORTS.last - PORTS.first + 1;
  const start = Math.floor(Math.random() * count);
  let last: unknown;
  for (let i = 0; i < count; i++) {
    try { return listen(PORTS.first + ((start + i) % count)); } catch (error) { last = error; }
  }
  throw new Error(`no free port from ${PORTS.first} to ${PORTS.last}: ${String(last)}`);
}

function startStub(responses: NonNullable<FleetCliCase["responses"]>): Stub {
  const requests: RecordedRequest[] = [];
  const server = onFreePort((port) => Bun.serve({
    port, hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const headers: RecordedRequest["headers"] = {};
      const fleetHeader = request.headers.get("x-herdr-fleet");
      const authorization = request.headers.get("authorization");
      if (fleetHeader !== null) headers["x-herdr-fleet"] = fleetHeader;
      if (authorization !== null) headers.authorization = authorization;
      let body: unknown;
      if (text !== "") { try { body = JSON.parse(text); } catch { body = text; } }
      requests.push({ method: request.method, path: `${url.pathname}${url.search}`, headers, ...(body === undefined ? {} : { body }) });
      const answer = responses[requests.length - 1];
      if (!answer) return Response.json({ error: { code: "no_response", message: "the case has no response for this request" } }, { status: 500 });
      return typeof answer.body === "string"
        ? new Response(answer.body, { status: answer.status, headers: { "content-type": "text/plain" } })
        : Response.json(answer.body ?? {}, { status: answer.status });
    },
  }));
  return { port: server.port!, requests, stop: () => server.stop(true) };
}

/**
 * A port from 7400 to 7499 that nothing listens on: free when the runner bound it and let it go. Another
 * process could take it before the CLI connects; the case then fails (its stderr no longer says the
 * server cannot be reached) rather than passing.
 */
async function closedPort(): Promise<number> {
  const server = onFreePort((port) => Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() }));
  const port = server.port!;
  await server.stop(true);
  return port;
}

/** Runs the CLI `command` (resolveTarget) on one case. */
export async function runCase(spec: FleetCliCase, command = resolveTarget()): Promise<Actual> {
  checkCase(spec);
  const stub = spec.server === "closed" ? undefined : startStub(spec.responses ?? []);
  const port = stub?.port ?? await closedPort();
  const url = `http://127.0.0.1:${port}`;
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "fleet-cli-case-")));
  try {
    for (const [name, text] of Object.entries(spec.files ?? {})) writeFileSync(join(cwd, name), text);
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
      TZ: "UTC", LANG: "en_US.UTF-8",
      ...spec.env,
      HERDR_FLEET_URL: spec.trailingSlash ? `${url}/` : url,
    };
    const child = Bun.spawn([...command, ...spec.argv], {
      cwd, env, stdin: spec.stdin === undefined ? "ignore" : new TextEncoder().encode(spec.stdin), stdout: "pipe", stderr: "pipe",
    });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, RUN_LIMIT_MS);
    let stdout: string, stderr: string, exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    } finally {
      clearTimeout(timer);
    }
    if (killed) throw new Error(`the CLI did not finish in ${RUN_LIMIT_MS} ms and was killed`);
    const pairs: Array<[string, string]> = [[url, "$URL"], [cwd, "$CWD"]];
    const requests = (stub?.requests ?? []).map((request) => ({
      ...request,
      path: request.path.split(encodeURIComponent(cwd)).join("$CWD"),
      ...(request.body === undefined ? {} : { body: substitute(request.body, pairs) }),
    }));
    return { requests, stdout: substitute(stdout, pairs) as string, stderr: substitute(stderr, pairs) as string, exitCode };
  } finally {
    await stub?.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}

const matches = (expected: Output, actual: string): boolean =>
  typeof expected === "string" ? expected === actual : new RegExp(`^(?:${expected.pattern})$`).test(actual);

/** `actual` in the shape of `expected`: an output its pattern matches is written as that pattern, so the two compare equal. */
export function comparable(expected: Expected | undefined, actual: Actual): Expected {
  const output = (want: Output | undefined, got: string): Output => (want !== undefined && typeof want !== "string" && matches(want, got) ? want : got);
  return { requests: actual.requests, stdout: output(expected?.stdout, actual.stdout), stderr: output(expected?.stderr, actual.stderr), exitCode: actual.exitCode };
}

/**
 * Writes what the CLI does now into the cases without `expected`, and into the named ones, rewriting
 * them; returns the names written.
 */
export async function update(names: string[], root = CASES_DIR, command = resolveTarget()): Promise<string[]> {
  const cases = loadCases(root);
  const unknown = names.filter((name) => !cases.some((c) => c.name === name));
  if (unknown.length) throw new Error(`no such case: ${unknown.join(", ")}`);
  const written: string[] = [];
  for (const c of cases) {
    if (c.spec.expected && !names.includes(c.name)) continue;
    const actual = await runCase(c.spec, command);
    // a case written with too few or too many answers would record the stub's no_response error as the contract
    const answers = c.spec.responses?.length ?? 0;
    if (c.spec.server !== "closed" && actual.requests.length !== answers) {
      throw new Error(`${c.name}: the case has ${answers} responses, but the CLI made ${actual.requests.length} requests; nothing was written for it`);
    }
    const expected = comparable(c.spec.expected, actual);
    writeFileSync(c.file, `${JSON.stringify({ ...c.spec, expected }, null, 2)}\n`);
    written.push(c.name);
  }
  return written;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const updating = args[0] === "--update";
  const names = updating ? args.slice(1) : args;
  try {
    const command = resolveTarget();
    if (updating) {
      const written = await update(names, CASES_DIR, command);
      console.log(written.length ? `wrote ${written.join(", ")}` : "every case has its expected value");
    } else {
      let failed = 0;
      const all = loadCases();
      const unknown = names.filter((name) => !all.some((c) => c.name === name));
      if (unknown.length) throw new Error(`no such case: ${unknown.join(", ")}`);
      const cases = all.filter((c) => !names.length || names.includes(c.name));
      for (const c of cases) {
        const actual = comparable(c.spec.expected, await runCase(c.spec, command));
        if (!Bun.deepEquals(actual, c.spec.expected)) {
          failed++;
          console.log(`FAIL ${c.name}\n  expected ${JSON.stringify(c.spec.expected)}\n  actual   ${JSON.stringify(actual)}`);
        }
      }
      console.log(`${cases.length - failed} passed, ${failed} failed`);
      process.exitCode = failed ? 1 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
